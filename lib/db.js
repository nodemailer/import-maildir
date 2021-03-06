'use strict';

const config = require('wild-config');
const mongodb = require('mongodb');
const Redis = require('ioredis');
const tools = require('./tools');
const MongoClient = mongodb.MongoClient;
const UserHandler = require('wildduck/lib/user-handler');
const MessageHandler = require('wildduck/lib/message-handler');

module.exports.database = false;
module.exports.gridfs = false;
module.exports.users = false;
module.exports.redis = false;
module.exports.redisConfig = false;
module.exports.messageHandler = false;
module.exports.userHandler = false;

let getDBConnection = (main, config, callback) => {
    if (main) {
        if (!config) {
            return callback(null, false);
        }
        if (config && !/[:/]/.test(config)) {
            return callback(null, main.db(config));
        }
    }
    MongoClient.connect(
        config,
        {
            useNewUrlParser: true,
            reconnectTries: 100000,
            reconnectInterval: 1000
        },
        (err, db) => {
            if (err) {
                return callback(err);
            }
            if (main && db.s && db.s.options && db.s.options.dbName) {
                db = db.db(db.s.options.dbName);
            }
            return callback(null, db);
        }
    );
};

module.exports.connect = callback => {
    getDBConnection(false, config.dbs.mongo, (err, db) => {
        if (err) {
            return callback(err);
        }

        if (db.s && db.s.options && db.s.options.dbName) {
            module.exports.database = db.db(db.s.options.dbName);
        } else {
            module.exports.database = db;
        }

        getDBConnection(db, config.dbs.gridfs, (err, gdb) => {
            if (err) {
                return callback(err);
            }
            module.exports.gridfs = gdb || module.exports.database;

            getDBConnection(db, config.dbs.users, (err, udb) => {
                if (err) {
                    return callback(err);
                }
                module.exports.users = udb || module.exports.database;

                module.exports.redisConfig = tools.redisConfig(config.dbs.redis);
                module.exports.redis = new Redis(module.exports.redisConfig);

                module.exports.messageHandler = new MessageHandler({
                    database: module.exports.database,
                    users: module.exports.users,
                    redis: module.exports.redis,
                    gridfs: module.exports.gridfs,
                    attachments: config.attachments
                });

                module.exports.userHandler = new UserHandler({
                    database: module.exports.database,
                    users: module.exports.users,
                    redis: module.exports.redis,
                    gridfs: module.exports.gridfs,
                    authlogExpireDays: Number(config.log.authlogExpireDays) || 30
                });

                module.exports.redis.connect(() => callback(null, module.exports.database));
            });
        });
    });
};
