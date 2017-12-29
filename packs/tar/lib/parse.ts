import {Emitter} from '@barlus/node/events';
import {Buffer} from '@barlus/node/buffer';
import {warner} from './warner';
import {Header} from './header';
import {Yallist} from '../ext/yallist';
import {ReadEntry} from './read-entry';
import {Pax} from './pax';
import {Unzip} from '../ext/minipass-zlib';
const maxMetaEntrySize = 1024 * 1024;
const gzipHeader = new Buffer([0x1f, 0x8b]);
const STATE = Symbol('state');
const WRITEENTRY = Symbol('writeEntry');
const READENTRY = Symbol('readEntry');
const NEXTENTRY = Symbol('nextEntry');
const PROCESSENTRY = Symbol('processEntry');
const EX = Symbol('extendedHeader');
const GEX = Symbol('globalExtendedHeader');
const META = Symbol('meta');
const EMITMETA = Symbol('emitMeta');
const BUFFER = Symbol('buffer');
const QUEUE = Symbol('queue');
const ENDED = Symbol('ended');
const EMITTEDEND = Symbol('emittedEnd');
const EMIT = Symbol('emit');
const UNZIP = Symbol('unzip');
const CONSUMECHUNK = Symbol('consumeChunk');
const CONSUMECHUNKSUB = Symbol('consumeChunkSub');
const CONSUMEBODY = Symbol('consumeBody');
const CONSUMEMETA = Symbol('consumeMeta');
const CONSUMEHEADER = Symbol('consumeHeader');
const CONSUMING = Symbol('consuming');
const BUFFERCONCAT = Symbol('bufferConcat');
const MAYBEEND = Symbol('maybeEnd');
const WRITING = Symbol('writing');
const ABORTED = Symbol('aborted');
const DONE = Symbol('onDone');
const noop = _ => true;
export class Parser extends Emitter {
    strict;
    maxMetaEntrySize;
    filter;
    writable;
    readable;
    constructor(opt) {
        opt = opt || {};
        super();
        if (opt.ondone) {
            this.on(DONE, opt.ondone);
        } else {
            this.on(DONE, _ => {
                this.emit('prefinish');
                this.emit('finish');
                this.emit('end');
                this.emit('close')
            });
        }
        this.strict = !!opt.strict;
        this.maxMetaEntrySize = opt.maxMetaEntrySize || maxMetaEntrySize;
        this.filter = typeof opt.filter === 'function' ? opt.filter : noop;
        // have to set this so that streams are ok piping into it
        this.writable = true;
        this.readable = false;
        this[QUEUE] = new Yallist();
        this[BUFFER] = null;
        this[READENTRY] = null;
        this[WRITEENTRY] = null;
        this[STATE] = 'begin';
        this[META] = '';
        this[EX] = null;
        this[GEX] = null;
        this[ENDED] = false;
        this[UNZIP] = null;
        this[ABORTED] = false;
        if (typeof opt.onwarn === 'function') {
            this.on('warn', opt.onwarn);
        }
        if (typeof opt.onentry === 'function') {
            this.on('entry', opt.onentry)
        }
    }
    [CONSUMEHEADER](chunk, position) {
        const header = new Header(chunk, position);
        if (header.nullBlock) {
            this[EMIT]('nullBlock');
        } else if (!header.cksumValid) {
            this.warn('invalid entry', header);
        } else if (!header.path) {
            this.warn('invalid: path is required', header);
        } else {
            const type = header.type;
            if (/^(Symbolic)?Link$/.test(type) && !header.linkpath) {
                this.warn('invalid: linkpath required', header);
            } else if (!/^(Symbolic)?Link$/.test(type) && header.linkpath) {
                this.warn('invalid: linkpath forbidden', header);
            } else {
                const entry = this[WRITEENTRY] = new ReadEntry(header, this[EX], this[GEX]);
                if (entry.meta) {
                    if (entry.size > this.maxMetaEntrySize) {
                        entry.ignore = true;
                        this[EMIT]('ignoredEntry', entry);
                        this[STATE] = 'ignore'
                    } else if (entry.size > 0) {
                        this[META] = '';
                        entry.on('data', c => this[META] += c);
                        this[STATE] = 'meta'
                    }
                } else {
                    this[EX] = null;
                    entry.ignore = entry.ignore || !this.filter(entry.path, entry);
                    if (entry.ignore) {
                        this[EMIT]('ignoredEntry', entry);
                        this[STATE] = entry.remain ? 'ignore' : 'begin'
                    } else {
                        if (entry.remain) {
                            this[STATE] = 'body';
                        } else {
                            this[STATE] = 'begin';
                            entry.end()
                        }
                        if (!this[READENTRY]) {
                            this[QUEUE].push(entry);
                            this[NEXTENTRY]()
                        } else {
                            this[QUEUE].push(entry)
                        }
                    }
                }
            }
        }
    }
    [PROCESSENTRY](entry) {
        let go = true;
        if (!entry) {
            this[READENTRY] = null;
            go = false
        } else if (Array.isArray(entry)) {
            this.emit.call(this, ...entry);
        } else {
            this[READENTRY] = entry;
            this.emit('entry', entry);
            if (!entry.emittedEnd) {
                entry.on('end', _ => this[NEXTENTRY]());
                go = false
            }
        }
        return go
    }
    [NEXTENTRY]() {
        do {
        } while (this[PROCESSENTRY](this[QUEUE].shift()));
        if (!this[QUEUE].length) {
            // At this point, there's nothing in the queue, but we may have an
            // entry which is being consumed (readEntry).
            // If we don't, then we definitely can handle more data.
            // If we do, and either it's flowing, or it has never had any data
            // written to it, then it needs more.
            // The only other possibility is that it has returned false from a
            // write() call, so we wait for the next drain to continue.
            const re = this[READENTRY];
            const drainNow = !re || re.flowing || re.size === re.remain;
            if (drainNow) {
                if (!this[WRITING]) {
                    this.emit('drain')
                }
            } else {
                re.once('drain', _ => this.emit('drain'))
            }
        }
    }
    [CONSUMEBODY](chunk, position) {
        // write up to but no  more than writeEntry.blockRemain
        const entry = this[WRITEENTRY];
        const br = entry.blockRemain;
        const c = (br >= chunk.length && position === 0) ? chunk
            : chunk.slice(position, position + br);
        entry.write(c);
        if (!entry.blockRemain) {
            this[STATE] = 'begin';
            this[WRITEENTRY] = null;
            entry.end()
        }
        return c.length
    }
    [CONSUMEMETA](chunk, position) {
        const entry = this[WRITEENTRY];
        const ret = this[CONSUMEBODY](chunk, position);
        // if we finished, then the entry is reset
        if (!this[WRITEENTRY]) {
            this[EMITMETA](entry);
        }
        return ret
    }
    [EMIT](ev, data?, extra?) {
        if (!this[QUEUE].length && !this[READENTRY]) {
            this.emit(ev, data, extra);
        } else {
            this[QUEUE].push([ev, data, extra])
        }
    }
    [EMITMETA](entry) {
        this[EMIT]('meta', this[META]);
        switch (entry.type) {
            case 'ExtendedHeader':
            case 'OldExtendedHeader':
                this[EX] = Pax.parse(this[META], this[EX], false);
                break;
            case 'GlobalExtendedHeader':
                this[GEX] = Pax.parse(this[META], this[GEX], true);
                break;
            case 'NextFileHasLongPath':
            case 'OldGnuLongPath':
                this[EX] = this[EX] || Object.create(null);
                this[EX].path = this[META].replace(/\0.*/, '');
                break;
            case 'NextFileHasLongLinkpath':
                this[EX] = this[EX] || Object.create(null);
                this[EX].linkpath = this[META].replace(/\0.*/, '');
                break;

            /* istanbul ignore next */
            default:
                throw new Error(`unknown meta: ${entry.type}`)
        }
    }
    [BUFFERCONCAT](c?) {
        if (c && !this[ABORTED]) {
            this[BUFFER] = this[BUFFER] ? Buffer.concat([this[BUFFER], c]) : c
        }
    }
    [MAYBEEND]() {
        if (this[ENDED] &&
            !this[EMITTEDEND] &&
            !this[ABORTED] &&
            !this[CONSUMING]) {
            this[EMITTEDEND] = true;
            const entry = this[WRITEENTRY];
            if (entry && entry.blockRemain) {
                const have = this[BUFFER] ? this[BUFFER].length : 0;
                this.warn(`Truncated input (needed ${entry.blockRemain} more bytes, only ${have} available)`, entry);
                if (this[BUFFER]) {
                    entry.write(this[BUFFER]);
                }
                entry.end()
            }
            this[EMIT](DONE)
        }
    }
    [CONSUMECHUNK](chunk?) {
        if (this[CONSUMING]) {
            this[BUFFERCONCAT](chunk)
        } else if (!chunk && !this[BUFFER]) {
            this[MAYBEEND]()
        } else {
            this[CONSUMING] = true;
            if (this[BUFFER]) {
                this[BUFFERCONCAT](chunk);
                const c = this[BUFFER];
                this[BUFFER] = null;
                this[CONSUMECHUNKSUB](c)
            } else {
                this[CONSUMECHUNKSUB](chunk)
            }
            while (this[BUFFER] && this[BUFFER].length >= 512 && !this[ABORTED]) {
                const c = this[BUFFER];
                this[BUFFER] = null;
                this[CONSUMECHUNKSUB](c)
            }
            this[CONSUMING] = false
        }
        if (!this[BUFFER] || this[ENDED]) {
            this[MAYBEEND]()
        }
    }
    [CONSUMECHUNKSUB](chunk?) {
        // we know that we are in CONSUMING mode, so anything written goes into
        // the buffer.  Advance the position and put any remainder in the buffer.
        let position = 0;
        let length = chunk.length;
        while (position + 512 <= length && !this[ABORTED]) {
            switch (this[STATE]) {
                case 'begin':
                    this[CONSUMEHEADER](chunk, position);
                    position += 512;
                    break;
                case 'ignore':
                case 'body':
                    position += this[CONSUMEBODY](chunk, position);
                    break;
                case 'meta':
                    position += this[CONSUMEMETA](chunk, position);
                    break;

                /* istanbul ignore next */
                default:
                    throw new Error(`invalid state: ${this[STATE]}`)
            }
        }
        if (position < length) {
            if (this[BUFFER]) {
                this[BUFFER] = Buffer.concat([chunk.slice(position), this[BUFFER]]);
            } else {
                this[BUFFER] = chunk.slice(position)
            }
        }
    }
    abort(msg, error) {
        this[ABORTED] = true;
        this.warn(msg, error);
        this.emit('abort')
    }
    write(chunk) {
        if (this[ABORTED]) {
            return;
        }
        // first write, might be gzipped
        if (this[UNZIP] === null && chunk) {
            if (this[BUFFER]) {
                chunk = Buffer.concat([this[BUFFER], chunk]);
                this[BUFFER] = null
            }
            if (chunk.length < gzipHeader.length) {
                this[BUFFER] = chunk;
                return true
            }
            for (let i = 0; this[UNZIP] === null && i < gzipHeader.length; i++) {
                if (chunk[i] !== gzipHeader[i]) {
                    this[UNZIP] = false
                }
            }
            if (this[UNZIP] === null) {
                const ended = this[ENDED];
                this[ENDED] = false;
                this[UNZIP] = new Unzip();
                this[UNZIP].on('data', chunk => this[CONSUMECHUNK](chunk));
                this[UNZIP].on('error', er =>
                    this.abort(`zlib error: ${er.message}`, er));
                this[UNZIP].on('end', _ => {
                    this[ENDED] = true;
                    this[CONSUMECHUNK]();
                });
                return ended ? this[UNZIP].end(chunk) : this[UNZIP].write(chunk)
            }
        }
        this[WRITING] = true;
        if (this[UNZIP]) {
            this[UNZIP].write(chunk);
        } else {
            this[CONSUMECHUNK](chunk);
        }
        this[WRITING] = false;
        // return false if there's a queue, or if the current entry isn't flowing
        const ret =
            this[QUEUE].length ? false :
                this[READENTRY] ? this[READENTRY].flowing :
                    true;
        // if we have no queue, then that means a clogged READENTRY
        if (!ret && !this[QUEUE].length) {
            this[READENTRY].once('drain', _ => this.emit('drain'));
        }
        return ret
    }
    end(chunk?) {
        if (!this[ABORTED]) {
            if (this[UNZIP]) {
                this[UNZIP].end(chunk);
            } else {
                this[ENDED] = true;
                this.write(chunk)
            }
        }
    }
    warn(msg, data) {
        warner(this, msg, data);
    }
}