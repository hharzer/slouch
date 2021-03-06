'use strict';

var FilteredStreamIterator = require('quelle').FilteredStreamIterator,
  CouchPersistentStreamIterator = require('./couch-persistent-stream-iterator'),
  StreamIterator = require('quelle').StreamIterator,
  sporks = require('sporks'),
  Promise = require('sporks/scripts/promise');

var System = function (slouch) {
  this._slouch = slouch;
  this._couchDB1 = null;
  this._partitioned = null;
};

System.prototype._isCouchDB1 = function () {
  return this.get().then(function (obj) {
    return obj.version[0] === '1';
  });
};

System.prototype.isCouchDB1 = function () {
  var self = this;
  return Promise.resolve().then(function () {
    if (self._couchDB1 === null) {
      return self._isCouchDB1().then(function (isCouchDB1) {
        self._couchDB1 = isCouchDB1;
        return self._couchDB1;
      });
    } else {
      return self._couchDB1;
    }
  });
};

System.prototype._supportPartitioned = function () {
  return this.get().then(function (obj) {
    return obj.features && obj.features.includes('partitioned');
  });
};

System.prototype.supportPartitioned = function () {
  var self = this;
  return Promise.resolve().then(function () {
    if (self._partitioned === null) {
      return self._supportPartitioned().then(function (supportPartitioned) {
        self._partitioned = supportPartitioned;
        return self._partitioned;
      });
    } else {
      return self._partitioned;
    }
  });
};

System.prototype.get = function () {
  return this._slouch._req({
    uri: this._slouch._url + '/',
    method: 'GET',
    parseBody: true
  });
};

System.prototype.reset = function (exceptDBNames) {
  var self = this,
    except = exceptDBNames ? sporks.flip(exceptDBNames) : {},
    dbsToDestroyAndRecreate = [];

  return self.isCouchDB1().then(function (isCouchDB1) {
    if (isCouchDB1) {
      dbsToDestroyAndRecreate = ['_replicator'];
      // CouchDB 1 automatically recreates the _users database
    } else {
      // CouchDB 2 does not automatically recreate any databases so we have to do it ourselves
      dbsToDestroyAndRecreate = ['_replicator', '_users'];
    }

    return Promise.resolve().then(function () {
      if (!isCouchDB1) {
        // We destroy _global_changes first so that we don't track any of the following changes
        return self._slouch.db.destroy('_global_changes');
      }
    }).then(function () {
      return self._slouch.db.all().each(function (db) {
        if (except[db]) {
          // Do nothing
          return Promise.resolve();
        } else if (dbsToDestroyAndRecreate.indexOf(db) !== -1) {
          return self._slouch.db.destroy(db).then(function () {
            return self._slouch.db.create(db);
          });
        } else {
          return self._slouch.db.destroy(db);
        }
      });
    }).then(function () {
      if (!isCouchDB1) {
        // We create _global_changes last after all the reset changes have been made
        return self._slouch.db.create('_global_changes');
      }
    });
  });
};

// Use a JSONStream so that we don't have to load a large JSON structure into memory
System.prototype.updates = function (params) {
  var indefinite = false,
    jsonStreamParseStr = null;

  if (params && params.feed === 'continuous') {
    indefinite = true;
    jsonStreamParseStr = undefined;
  } else {
    jsonStreamParseStr = 'results.*';
  }

  return new CouchPersistentStreamIterator({
    url: this._slouch._url + '/_db_updates',
    method: 'GET',
    qs: params
  }, jsonStreamParseStr, indefinite, this._slouch._request);
};

System.prototype._cloneParams = function (params) {
  return params ? sporks.clone(params) : {};
};

System.prototype._itemToUpdate = function (item) {
  if (item.id) {
    // Repackage the item so that it is compatible with _db_updates.
    var parts = item.id.split(':');
    return {
      db_name: parts[1],
      type: parts[0]
    };
  } else {
    // Ignore items that don't have ids
    return undefined;
  }
};

System.prototype.updatesViaGlobalChanges = function (params) {
  var self = this,
    iterator = new StreamIterator();

  self._slouch.db.get('_global_changes').then(function (dbDoc) {
    var clonedParams = self._cloneParams(params);
    clonedParams.since = dbDoc.update_seq;

    // We pipe to the returned iterator so that the function can return an iterator who's content is
    // deferred.
    self._slouch.db.changes('_global_changes', clonedParams).pipe(iterator);
  });

  return new FilteredStreamIterator(iterator, function (item) {
    return self._itemToUpdate(item);
  });
};

// The _db_updates feed in CouchDB does not include any history, i.e. any updates before when we
// start listening to the feed. CouchDB 2 on the other hand stores the complete history in the
// _global_changes database. We use the _changes feed on the _global_changes database to provide a
// backwards compatible API.
System.prototype.updatesNoHistory = function (params) {
  var self = this,
    iterator = new StreamIterator();

  self._slouch.system.isCouchDB1().then(function (isCouchDB1) {
    if (isCouchDB1) {
      return self.updates(params);
    } else {
      return self.updatesViaGlobalChanges(params);
    }
  }).then(function (_iterator) {
    // We pipe to the returned iterator so that the function can return an iterator who's content is
    // deferred.
    _iterator.pipe(iterator);
  });

  return iterator;
};

module.exports = System;
