'use strict';

const config = require('wild-config');

if (process.env.NODE_CONFIG_ONLY === 'true') {
    console.log(require('util').inspect(config, false, 22)); // eslint-disable-line
    return process.exit();
}

const cp = require('child_process');
const log = require('npmlog');
const logs = require('./logs');

log.level = config.log.level;

const workerPath = `${__dirname}/worker.js`;

let running = true;
let workers = new Map();
let waitList = [];
let idling = [];
let foldersOnly = false;

let pending = new Set();

config.on('reload', () => {
    log.level = config.log.level;
    workers.forEach(child => {
        try {
            child.kill('SIGHUP');
        } catch (E) {
            //ignore
        }
    });
});

function checkIdling() {
    while (waitList.length && idling.length) {
        let worker = idling.shift();
        if (workers.has(worker)) {
            let item = waitList.shift();
            pending.add(item);
            workers.set(worker, item);
            log.info(Date.now() + ' C#' + worker.pid, '#%s Issued %s to worker %s', item.user, item.path, worker.pid);
            worker.send({ entry: item, foldersOnly });
        }
    }
}

function getNextLine(worker) {
    if (!waitList.length) {
        if (!pending.size) {
            log.info(Date.now() + ' upload', 'All done');
            return stop();
        }
        return;
    }

    let item = waitList.shift();
    pending.add(item);
    workers.set(worker, item);
    log.info(Date.now() + ' C#' + worker.pid, '#%s Issued %s to worker %s', item.user, item.path, worker.pid);
    worker.send({ entry: item, foldersOnly });
}

function stop(signal) {
    running = false;
    workers.forEach((state, worker) => {
        worker.kill();
    });
    setImmediate(() => process.exit(signal));
}

function spawnWorker() {
    if (!running) {
        return false;
    }

    const worker = cp.fork(workerPath);
    log.info(Date.now() + ' Master', 'Forked worker %s', worker.pid);
    worker.on('message', m => {
        if (m && m.idle) {
            if (workers.has(worker)) {
                let item = workers.get(worker);
                log.info(Date.now() + ' C#' + worker.pid, '#%s Worker finished %s', item.user, item.path);
            }
            pending.delete(workers.get(worker));
            workers.set(worker, false);
            getNextLine(worker);
        }

        if (m && m.msg) {
            if (workers.has(worker)) {
                let item = workers.get(worker);
                log[m.level || 'info'](Date.now() + ' C#' + worker.pid, '#%s LOGMSG ' + m.msg, item.user);
            } else {
                log[m.level || 'info'](Date.now() + ' C#' + worker.pid, 'LOGMSG' + m.msg);
            }
        }

        if (m && m.t && m.m) {
            logs(m.t, m.m);
        }
    });

    let removeWorker = () => {
        if (!workers.has(worker)) {
            // already processed
            return;
        }
        let pendingItem = workers.get(worker);

        if (pendingItem) {
            log.info(Date.now() + ' C#' + worker.pid, '#%s Worker died while processing %s', pendingItem.user, pendingItem.path);
        } else {
            log.info(Date.now() + ' C#' + worker.pid, 'Worker %s died', worker.pid);
        }

        workers.delete(worker);

        if (running) {
            setTimeout(spawnWorker, 1000);
        }

        if (pendingItem) {
            pending.delete(pendingItem);
            waitList.push(pendingItem);
            checkIdling();
        }
    };

    worker.on('exit', removeWorker);
    worker.on('error', removeWorker);
    worker.on('disconnect', removeWorker);
}

module.exports.start = (uploaders, listing, args) => {
    waitList = listing;

    if (args) {
        foldersOnly = !!args.foldersOnly;
    }

    log.info(Date.now() + ' Master', 'Starting importer');
    log.info(Date.now() + ' Master', 'Generate folders only: %s (--foldersOnly)', foldersOnly ? 'YES' : 'NO');

    uploaders = Number(uploaders) || config.general.uploaders;

    for (let i = 0; i < uploaders; i++) {
        setImmediate(spawnWorker);
    }
};
