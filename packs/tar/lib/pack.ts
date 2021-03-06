'use strict';
import {stat, lstat, readdir, statSync, lstatSync, readdirSync} from '@barlus/node/fs';
import {resolve} from '@barlus/node/path';
import {process} from '@barlus/node/process';
import {Buffer} from '@barlus/node/buffer';
import {warner} from './warner';
import {MiniPass} from '../ext/minipass';
import {Gzip} from '../ext/minipass-zlib';
import {ReadEntry} from './read-entry';
import {WriteEntry, WriteEntrySync, WriteEntryTar} from './write-entry';
import {Yallist} from '../ext/yallist';
//#region consts
const EOF = Buffer.alloc(1024);
const ONSTAT = Symbol('onStat');
const ENDED = Symbol('ended');
const QUEUE = Symbol('queue');
const CURRENT = Symbol('current');
const PROCESS = Symbol('process');
const PROCESSING = Symbol('processing');
const PROCESSJOB = Symbol('processJob');
const JOBS = Symbol('jobs');
const JOBDONE = Symbol('jobDone');
const ADDFSENTRY = Symbol('addFSEntry');
const ADDTARENTRY = Symbol('addTarEntry');
const STAT = Symbol('stat');
const READDIR = Symbol('readdir');
const ONREADDIR = Symbol('onreaddir');
const PIPE = Symbol('pipe');
const ENTRY = Symbol('entry');
const ENTRYOPT = Symbol('entryOpt');
const WRITEENTRYCLASS = Symbol('writeEntryClass');
const WRITE = Symbol('write');
const ONDRAIN = Symbol('ondrain');
//#endregion
// A readable tar stream creator
// Technically, this is a transform stream that you write paths into,
// and tar format comes out of.
// The `add()` method is like `write()` but returns this,
// and end() return `this` as well, so you can
// do `new Pack(opt).add('files').add('dir').end().pipe(output)
// You could also do something like:
// streamOfPaths().pipe(new Pack()).pipe(new fs.WriteStream('out.tar'))
export class PackJob {
    path = null;
    absolute = null;
    entry = null;
    stat = null;
    readdir = null;
    pending = false;
    ignore = false;
    piped = false;
    constructor(path, absolute) {
        this.path = path || './';
        this.absolute = absolute;
    }
}
export class Pack extends MiniPass {
    opt;
    cwd;
    maxReadSize;
    preservePaths;
    strict;
    noPax;
    prefix;
    linkCache;
    statCache;
    readdirCache;
    zip;
    portable;
    noDirRecurse;
    follow;
    noMtime;
    filter;
    jobs;
    constructor(opt: any = {}) {
        super(opt);
        this.opt = opt;
        this.cwd = opt.cwd || process.cwd();
        this.maxReadSize = opt.maxReadSize;
        this.preservePaths = !!opt.preservePaths;
        this.strict = !!opt.strict;
        this.noPax = !!opt.noPax;
        this.prefix = (opt.prefix || '').replace(/(\\|\/)+$/, '');
        this.linkCache = opt.linkCache || new Map();
        this.statCache = opt.statCache || new Map();
        this.readdirCache = opt.readdirCache || new Map();
        this[WRITEENTRYCLASS] = WriteEntry;
        if (typeof opt.onwarn === 'function') {
            this.on('warn', opt.onwarn);
        }
        this.zip = null;
        if (opt.gzip) {
            if (typeof opt.gzip !== 'object') {
                opt.gzip = {};
            }
            this.zip = new Gzip(opt.gzip);
            this.zip.on('data', chunk => super.write(chunk));
            this.zip.on('end', _ => super.end());
            this.zip.on('drain', _ => this[ONDRAIN]());
            this.on('resume', _ => this.zip.resume())
        } else {
            this.on('drain', this[ONDRAIN]);
        }
        this.portable = !!opt.portable;
        this.noDirRecurse = !!opt.noDirRecurse;
        this.follow = !!opt.follow;
        this.noMtime = !!opt.noMtime;
        this.filter = typeof opt.filter === 'function' ? opt.filter : _ => true;
        this[QUEUE] = new Yallist;
        this[JOBS] = 0;
        this.jobs = +opt.jobs || 4;
        this[PROCESSING] = false;
        this[ENDED] = false
    }
    [WRITE](chunk) {
        return super.write(chunk)
    }
    warn(msg, data) {
        warner(this, msg, data)
    }
    add(path) {
        this.write(path);
        return this
    }
    end(path) {
        if (path) {
            this.write(path);
        }
        this[ENDED] = true;
        this[PROCESS]();
        return this
    }
    write(path) {
        if (this[ENDED]) {
            throw new Error('write after end');
        }
        if (path instanceof ReadEntry) {
            this[ADDTARENTRY](path);
        } else {
            this[ADDFSENTRY](path);
        }
        return this.flowing
    }
    [ADDTARENTRY](p) {
        const absolute = resolve(this.cwd, p.path);
        if (this.prefix) {
            p.path = this.prefix + '/' + p.path.replace(/^\.(\/+|$)/, '');
        }
        // in this case, we don't have to wait for the stat
        if (!this.filter(p.path, p)) {
            p.resume();
        } else {
            const job = new PackJob(p.path, absolute);
            job.entry = new WriteEntryTar(p, this[ENTRYOPT](job));
            job.entry.on('end', _ => this[JOBDONE](job));
            this[JOBS] += 1;
            this[QUEUE].push(job)
        }
        this[PROCESS]()
    }
    [ADDFSENTRY](p) {
        const absolute = resolve(this.cwd, p);
        if (this.prefix) {
            p = this.prefix + '/' + p.replace(/^\.(\/+|$)/, '');
        }
        this[QUEUE].push(new PackJob(p, absolute));
        this[PROCESS]()
    }
    [STAT](job) {
        job.pending = true;
        this[JOBS] += 1;
        const st = this.follow ? stat : lstat;
        st(job.absolute, (er, stat) => {
            job.pending = false;
            this[JOBS] -= 1;
            if (er) {
                this.emit('error', er);
            } else {
                this[ONSTAT](job, stat)
            }
        })
    }
    [ONSTAT](job, stat) {
        this.statCache.set(job.absolute, stat);
        job.stat = stat;
        // now we have the stat, we can filter it.
        if (!this.filter(job.path, stat)) {
            job.ignore = true;
        }
        this[PROCESS]()
    }
    [READDIR](job) {
        job.pending = true;
        this[JOBS] += 1;
        readdir(job.absolute, (er, entries) => {
            job.pending = false;
            this[JOBS] -= 1;
            if (er) {
                return this.emit('error', er);
            }
            this[ONREADDIR](job, entries)
        })
    }
    [ONREADDIR](job, entries) {
        this.readdirCache.set(job.absolute, entries);
        job.readdir = entries;
        this[PROCESS]()
    }
    [PROCESS]() {
        if (this[PROCESSING]) {
            return;
        }
        this[PROCESSING] = true;
        for (let w = this[QUEUE].head;
             w !== null && this[JOBS] < this.jobs;
             w = w.next) {
            this[PROCESSJOB](w.value);
            if (w.value.ignore) {
                const p = w.next;
                this[QUEUE].removeNode(w);
                w.next = p
            }
        }
        this[PROCESSING] = false;
        if (this[ENDED] && !this[QUEUE].length && this[JOBS] === 0) {
            if (this.zip) {
                this.zip.end(EOF);
            } else {
                super.write(EOF);
                super.end()
            }
        }
    }
    get [CURRENT]() {
        return this[QUEUE] && this[QUEUE].head && this[QUEUE].head.value
    }
    [JOBDONE](job) {
        this[QUEUE].shift();
        this[JOBS] -= 1;
        this[PROCESS]()
    }
    [PROCESSJOB](job) {
        if (job.pending) {
            return;
        }
        if (job.entry) {
            if (job === this[CURRENT] && !job.piped) {
                this[PIPE](job);
            }
            return
        }
        if (!job.stat) {
            if (this.statCache.has(job.absolute)) {
                this[ONSTAT](job, this.statCache.get(job.absolute));
            } else {
                this[STAT](job)
            }
        }
        if (!job.stat) {
            return;
        }
        // filtered out!
        if (job.ignore) {
            return;
        }
        if (!this.noDirRecurse && job.stat.isDirectory() && !job.readdir) {
            if (this.readdirCache.has(job.absolute)) {
                this[ONREADDIR](job, this.readdirCache.get(job.absolute));
            } else {
                this[READDIR](job);
            }
            if (!job.readdir) {
                return
            }
        }
        // we know it doesn't have an entry, because that got checked above
        job.entry = this[ENTRY](job);
        if (!job.entry) {
            job.ignore = true;
            return
        }
        if (job === this[CURRENT] && !job.piped) {
            this[PIPE](job)
        }
    }
    [ENTRYOPT](job) {
        return {
            onwarn: (msg, data) => {
                this.warn(msg, data)
            },
            noPax: this.noPax,
            cwd: this.cwd,
            absolute: job.absolute,
            preservePaths: this.preservePaths,
            maxReadSize: this.maxReadSize,
            strict: this.strict,
            portable: this.portable,
            linkCache: this.linkCache,
            statCache: this.statCache,
            noMtime: this.noMtime
        }
    }
    [ENTRY](job) {
        this[JOBS] += 1;
        try {
            return new this[WRITEENTRYCLASS](job.path, this[ENTRYOPT](job))
                .on('end', () => this[JOBDONE](job))
                .on('error', er => this.emit('error', er))
        } catch (er) {
            this.emit('error', er)
        }
    }
    [ONDRAIN]() {
        if (this[CURRENT] && this[CURRENT].entry) {
            this[CURRENT].entry.resume()
        }
    }
    // like .pipe() but using super, because our write() is special
    [PIPE](job) {
        job.piped = true;
        if (job.readdir) {
            job.readdir.forEach(entry => {
                const p = this.prefix ?
                    job.path.slice(this.prefix.length + 1) || './'
                    : job.path;
                const base = p === './' ? '' : p.replace(/\/*$/, '/');
                this[ADDFSENTRY](base + entry)
            });
        }
        const source = job.entry;
        const zip = this.zip;
        if (zip) {
            source.on('data', chunk => {
                if (!zip.write(chunk)) {
                    source.pause()
                }
            });
        } else {
            source.on('data', chunk => {
                if (!super.write(chunk)) {
                    source.pause()
                }
            })
        }
    }
    pause() {
        if (this.zip) {
            this.zip.pause();
        }
        return super.pause()
    }
}
export class PackSync extends Pack {
    constructor(opt) {
        super(opt);
        this[WRITEENTRYCLASS] = WriteEntrySync
    }
    // pause/resume are no-ops in sync streams.
    pause() {
    }
    resume() {
    }
    [STAT](job) {
        const stat = this.follow ? statSync : lstatSync;
        this[ONSTAT](job, stat(job.absolute))
    }
    [READDIR](job) {
        this[ONREADDIR](job, readdirSync(job.absolute))
    }
    // gotta get it all in this tick
    [PIPE](job) {
        const source = job.entry;
        const zip = this.zip;
        if (job.readdir) {
            job.readdir.forEach(entry => {
                const p = this.prefix ?
                    job.path.slice(this.prefix.length + 1) || './'
                    : job.path;
                const base = p === './' ? '' : p.replace(/\/*$/, '/');
                this[ADDFSENTRY](base + entry)
            });
        }
        if (zip) {
            source.on('data', chunk => {
                zip.write(chunk)
            });
        } else {
            source.on('data', chunk => {
                super[WRITE](chunk)
            })
        }
    }
}
