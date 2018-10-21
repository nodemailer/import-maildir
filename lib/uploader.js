'use strict';

const fs = require('fs');
const log = require('npmlog');
const db = require('./db');
const pathlib = require('path');
const ObjectID = require('mongodb').ObjectID;

let userqueue = new Map();
let users = new WeakMap();

let mailboxqueue = new Map();
let mailboxes = new WeakMap();

let counter = 0;

module.exports.getUser = (userObj, callback) => {
    let start;

    start = Date.now();
    getCachedUser(userObj, (err, userData) => {
        if (err) {
            log.error('user', 'Failed to retrieve user data for %s: %s (%s ms)', userObj.address, err.message, Date.now() - start);
            return callback(err);
        }

        if (!userData) {
            log.error('user', 'Failed to retrieve user data for %s: User not found (%s ms)', userObj.address, Date.now() - start);
            return callback(new Error('User not found'));
        }

        return callback(null, userData);
    });
};

module.exports.ensureFolder = (basepath, userObj, folderObj, callback) => {
    let start;

    start = Date.now();
    getCachedUser(userObj, (err, userData) => {
        if (err) {
            log.error('user', 'Failed to retrieve user data for %s: %s (%s ms)', userObj.address, err.message, Date.now() - start);
            return callback(err);
        }

        if (!userData) {
            log.error('user', 'Failed to retrieve user data for %s: User not found (%s ms)', userObj.address, Date.now() - start);
            return callback(new Error('User not found'));
        }

        log.silly('timer', 'User %s[%s] resolved in %s ms', userData.address, userData._id, Date.now() - start);

        start = Date.now();
        getCachedMailbox(userData, folderObj, (err, mailboxData) => {
            if (err) {
                log.error('mailbox', 'Failed to retrieve mailbox data for %s/%s: %s (%s ms)', folderObj.path, err.message, Date.now() - start);
                return callback(err);
            }

            if (!mailboxData) {
                log.error('mailbox', 'Failed to retrieve mailbox data for %s: Not found (%s ms)', folderObj.path, Date.now() - start);
                return callback(new Error('User not found'));
            }

            log.silly('timer', 'Mailbox %s:%s[%s] resolved in %s ms', folderObj.path, mailboxData.path, mailboxData._id, Date.now() - start);

            return callback(null, {
                userData,
                mailboxData
            });
        });
    });
};

module.exports.upload = (basepath, userObj, folderObj, messageObj, callback) => {
    module.exports.ensureFolder(basepath, userObj, folderObj, (err, data) => {
        if (err) {
            return callback(err);
        }
        let userData = data.userData;
        let mailboxData = data.mailboxData;

        let start;

        let mpath = pathlib.join(basepath, messageObj.path);

        let stream = fs.createReadStream(mpath);
        let chunks = [];
        let chunklen = 0;
        let emailChecked = false;
        let isEmail = false;
        let isMbox = false;

        stream.on('readable', () => {
            let chunk;
            while ((chunk = stream.read()) !== null) {
                chunks.push(chunk);
                chunklen += chunk.length;

                if (chunklen > 100 && !emailChecked) {
                    let c;
                    if (chunks.length > 1) {
                        c = Buffer.concat(chunks, chunklen).toString();
                    } else {
                        c = chunk.toString();
                    }
                    emailChecked = true;
                    if (/^[\w-]+:/.test(c)) {
                        isEmail = true;
                    } else if (/^from [^@]+@[^@]+ /i.test(c)) {
                        isMbox = true;
                    }
                }
            }
        });

        stream.once('error', err => {
            log.error('Archive', err);
            callback(new Error('Error reading from stream. ' + err.message));
        });

        stream.once('end', () => {
            if (!isEmail && !isMbox) {
                chunks = null;
                chunklen = null;
                log.info('upload', '^%s Skipped non-email "%s"', ++counter, mpath);
                return callback(null, false, 'NOMAIL');
            }

            if (isMbox && chunks.length) {
                // remove first line, leave else as is
                let chunkStr = chunks[0].toString('binary');
                let br = chunkStr.match(/\r?\n/);
                if (br) {
                    chunkStr = chunkStr.substr(br.index + br[0].length);
                    chunks[0] = Buffer.from(chunkStr, 'binary');
                    chunklen -= br.index + br[0].length;
                }
            }

            let raw = Buffer.concat(chunks, chunklen);

            start = Date.now();

            db.messageHandler.prepareMessage(
                {
                    raw
                },
                (err, prepared) => {
                    if (err) {
                        return callback(err);
                    }
                    prepared.idate = messageObj.time ? new Date(messageObj.time * 1000) : prepared.hdate;
                    if (prepared.hdate < prepared.idate) {
                        prepared.idate = prepared.hdate;
                    }
                    let maildata = db.messageHandler.indexer.getMaildata(prepared.mimeTree);

                    log.info('timer', 'Message parsed in %s ms', Date.now() - start);

                    if (/@import\.info\.message/.test(prepared.msgid)) {
                        // do not import information message
                        // delete it instead
                        return fs.unlink(mpath, err => {
                            if (err) {
                                log.error('upload', 'DELETEFAIL user=%s file=%s msg=%s error=%s', userData.address, mpath, prepared.msgid, err.message);
                                return callback(err);
                            }
                            log.info('upload', '^%s DELETED user=%s file=%s msg=%s', ++counter, userData.address, mpath, prepared.msgid);
                            callback(null, true, 'DELETED ' + mpath);
                        });
                    }

                    let flags = messageObj.flags;
                    if (!flags.includes('$wd$import')) {
                        flags.push('$wd$import');
                    }

                    let messageOptions = {
                        user: userData._id,
                        mailbox: mailboxData._id,

                        prepared,
                        maildata,

                        meta: {
                            source: 'Import',
                            to: userData.address,
                            file: mpath,
                            time: Date.now()
                        },

                        filters: [],

                        date: prepared.hdate,
                        flags,

                        // if similar message exists, then skip
                        skipExisting: true
                    };

                    start = Date.now();
                    db.messageHandler.add(messageOptions, (err, inserted, info) => {
                        log.info('timer', 'Message stored in %s ms', Date.now() - start);
                        if (err) {
                            log.error('upload', 'STOREFAIL user=%s file=%s msg=%s error=%s', userData.address, messageObj.name, prepared.msgid, err.message);
                            return callback(err);
                        }

                        log.info(
                            'upload',
                            '^%s STORE%s %s user=%s file=%s folder=%s msg=%s',
                            ++counter,
                            (info.status || '').toUpperCase(),
                            info.id,
                            userData.address,
                            messageObj.name,
                            mailboxData._id,
                            prepared.msgid
                        );
                        callback(null, true, 'STORE' + (info.status || '').toUpperCase() + ' ' + mailboxData._id + '/' + info.id);
                    });
                }
            );
        });
    });
};

module.exports.init = callback => {
    db.connect(err => {
        if (err) {
            log.error('Db', 'Failed to setup database connection');
            return process.exit(1);
        }
        callback(null, true);
    });
};

function getMailbox(userData, folderObj, next) {
    let path = folderObj.folder.join('/'); //.replace(/^INBOX\//, '');

    if (mailboxqueue.has(folderObj.path)) {
        return mailboxqueue.get(folderObj.path).push(next);
    }

    mailboxqueue.set(folderObj.path, [next]);

    let done = (...args) => {
        let queue = mailboxqueue.get(folderObj.path);
        userqueue.delete(path);
        queue.forEach(next => setImmediate(() => next(...args)));
    };

    let query = {
        user: userData._id
    };

    if (folderObj.specialUse && folderObj.specialUse !== 'INBOX') {
        query.specialUse = folderObj.specialUse;
    } else {
        query.path = path;
    }

    let tryCount = 0;
    let tryCreate = () => {
        db.database.collection('mailboxes').findOne(query, (err, mailboxData) => {
            if (err) {
                log.error('Archive', err);
                return done(new Error('Database error'));
            }

            if (mailboxData) {
                return done(null, mailboxData);
            }

            mailboxData = {
                _id: new ObjectID(),
                user: userData._id,
                path,
                specialUse: false,
                uidValidity: Math.floor(Date.now() / 1000),
                uidNext: 1,
                modifyIndex: 0,
                subscribed: true,
                flags: [],
                retention: 0
            };

            db.database.collection('mailboxes').insertOne(mailboxData, err => {
                if (err) {
                    if (tryCount++ < 5 && err.code === 11000) {
                        // try again, seems to alreayd exist
                        return setTimeout(tryCreate, 150);
                    }

                    log.error('Archive', err);
                    return done(new Error('Database error'));
                }
                log.info('Archive', 'Created folder "%s" for %s', path, userData.address);
                return done(null, mailboxData);
            });
        });
    };
    tryCreate(true);
}

function getUser(address, next) {
    if (userqueue.has(address)) {
        return userqueue.get(address).push(next);
    }
    userqueue.set(address, [next]);

    let done = (...args) => {
        let queue = userqueue.get(address);
        userqueue.delete(address);
        queue.forEach(next => setImmediate(() => next(...args)));
    };

    db.userHandler.get(
        address,
        {
            name: true,
            address: true,
            filters: true,
            forwards: true,
            forward: true,
            targetUrl: true,
            autoreply: true
        },
        (err, userData) => {
            if (err) {
                log.error('Archive', err);
                return done(new Error('Database error'));
            }

            if (userData) {
                return done(null, userData);
            }

            return done(null, false);
        }
    );
}

function getCachedUser(userObj, callback) {
    if (users.has(userObj)) {
        return callback(null, users.get(userObj));
    }
    getUser(userObj.address, (err, userData) => {
        if (err) {
            log.error('Archive', err);
            return callback(new Error('Database error'));
        }
        if (!userData) {
            return callback(new Error('Unknown recipient'));
        }
        users.set(userObj, userData);
        callback(null, userData);
    });
}

function getCachedMailbox(userData, folderObj, callback) {
    if (mailboxes.has(folderObj)) {
        return callback(null, mailboxes.get(folderObj));
    }
    getMailbox(userData, folderObj, (err, mailboxData) => {
        if (err) {
            log.error('Archive', err);
            return callback(new Error('Database error'));
        }
        if (!mailboxData) {
            return callback(new Error('Unknown mailbox'));
        }
        mailboxes.set(folderObj, mailboxData);
        callback(null, mailboxData);
    });
}
