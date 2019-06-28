const _ = require('lodash');
const clone = require('clone');
const inflection = require('inflection');
const escapeStringRegexp = require('escape-string-regexp');
const crypto = require('crypto');
const debug = require('debug')('lounge');

const utils = require('./utils');
const schemaUtils = require('./schema.utils');
const normalizeProperties = require('./normalize');

const trailingDigitReg = new RegExp('^\\d+$');
const MAX_REF_KEY_LENGTH = 250;

class Schema {
  /**
   * @classdesc Schema class represents the schema definition. It includes properties, methods, static methods, and any
   * middleware we want to define.
   *
   * @description Creates an object schema
   * @class
   * @public
   * @param {Object} descriptor - the schema definition
   * @param {Object} options
   * @param {Boolean} options.strict - By default (<code>true</code>), allow only values in the schema to be set.
   *                                   When this is <code>false</code>, setting new fields will dynamically add the field
   *                                   to the schema as type "any".
   * @param {Boolean} options.dotNotation - Allow fields to be set via dot notation. Default: <code>true</code>.
   *                                      <code>obj['user.name'] = 'Joe'; -> obj: { user: 'Joe' }</code>
   *
   * @param {Boolean} options.minimize - "minimize" schemas by removing empty objects. Default: <code>true</code>
   * @param {Object} options.toObject - <code>toObject</code> method.
   * @param {Boolean} options.toObject.minimize - "minimize" schemas by removing empty objects. Default: <code>true</code>
   * @param {Function} options.toObject.transform - transform function
   * @param {Boolean} options.toObject.virtuals - whether to include virtual properties. Default: <code>false</code>
   * @param {Boolean} options.toObject.dateToISO - convert dates to string in ISO format using <code>Date.toISOString()</code>. Default:  <code>false</code>
   * @param {Object} options.toJSON - options for <code>toJSON</code> method options, similar to above
   * @param {Boolean} options.strict - ensures that value passed in to assigned that were not specified in our
   *                                   schema do not get saved
   * @param {Function} options.onBeforeValueSet - function called when write operations on an object takes place. Currently,
   * it will only notify of write operations on the object itself and will not notify you when child objects are written to.
   * If you return false or throw an error within the onBeforeValueSet handler, the write operation will be cancelled.
   * Throwing an error will add the error to the error stack.
   * @param {Function} options.onValueSet - Similar to <code>onBeforeValueSet</code>, but called after we've set a value on the key,
   *
   * @param {Object} options.saveOptions - options for couchbase <code>save</code> method, such as <code>expiry</code>, <code>replicate_to</code>, and <code>persist_to</code>.
   *                                       These options will propagate to all <code>save()</code> calls automatically and all index reference documents.
   *                                       If a <code>save()</code> call has those options they are used over ones defined in the schema options.
   * @example
   * var schema = new lounge.Schema({ name: String })
   * @example <caption>with <code>onBeforeValueSet</code></caption>
   * var User = lounge.schema({ name: String }, {
   *   onBeforeValueSet: function(key, value) {
   *     if(key === 'name' && value.indexOf('Joe') >= 0) {
   *       return false
   *     })
   *   }
   * })
   *
   * var User = lounge.model('User', schema)
   * var user = new User()
   * user.name = 'Bill' // name not set
   * user.name = 'Joe Smith' //  { name: 'Joe Smith' }
   */
  constructor(descriptor, options = {}) {
    // Create object for options if doesn't exist and merge with defaults.
    this.options = _.extend(
      {
        strict: true,
        dotNotation: true
      },
      options
    );

    this.methods = {};
    this.statics = {};
    this.hooks = {};
    this.refs = {};
    this.indexes = {};

    // document key settings
    this.key = {
      docKeyKey: '',
      prefix: null,
      suffix: null,
      generate: true
    };

    this.add(descriptor);

    // apply these if needed
    if (!this.key.prefix && _.isString(this.options.keyPrefix)) {
      this.key.prefix = this.options.keyPrefix;
    }

    if (this.options.dynamicKey) {
      this.key.dynamicKey = this.options.dynamicKey;
    }

    if (!this.key.suffix && _.isString(this.options.keySuffix)) {
      this.key.suffix = this.options.keySuffix;
    }
  }

  /*!
   * Apply document key = require(descriptor
   * @param descriptor
   */
  _applyDocumentKey(descriptor) {
    // find the document key key
    let docKeyFound = false;
    for (const prop in descriptor) {
      if (descriptor.hasOwnProperty(prop)) {
        if (utils.isPlainObject(descriptor[prop]) && descriptor[prop].key === true) {
          if (descriptor[prop].index === true) {
            throw new TypeError('Schema key cannot be index field');
          }

          if (descriptor[prop].ref) {
            throw new TypeError('Schema key cannot be reference property');
          }

          if (
            descriptor[prop].type &&
            descriptor[prop].type !== String &&
            descriptor[prop].type !== Number &&
            descriptor[prop].type !== 'number' &&
            descriptor[prop].type !== 'string'
          ) {
            throw new TypeError('Schema expects key to be a String or a Number');
          }

          docKeyFound = true;
          this.key.generate = false;

          this.key.docKeyKey = prop;
          if (_.isString(descriptor[prop].prefix)) {
            this.key.prefix = descriptor[prop].prefix;
          }

          if (_.isString(descriptor[prop].suffix)) {
            this.key.suffix = descriptor[prop].suffix;
          }

          if (_.isBoolean(descriptor[prop].generate)) {
            this.key.generate = descriptor[prop].generate;
          }

          this.descriptor[this.key.docKeyKey] = normalizeProperties.call(this, descriptor[prop], this.key.docKeyKey);
        }
      }
    }

    if (!docKeyFound && !this.key.docKeyKey) {
      // manually add one, should be one-op
      this.key.docKeyKey = 'id';
      this.descriptor[this.key.docKeyKey] = normalizeProperties.call(this, String, this.key.docKeyKey);
    }
  }

  /*!
   * Find all embedded documents
   * @param descriptor
   */
  _getRefs(descriptor) {
    const refs = schemaUtils.getRefs(descriptor);
    if (refs && refs.length > 0) {
      refs.forEach(elem => {
        this.refs[elem.path] = elem;
      });
    }
  }

  /*!
   * Find all indexes
   * @param descriptor
   */
  _getIndexes(descriptor, key) {
    const inds = schemaUtils.getIndexes(descriptor, key);

    if (inds && inds.length > 0) {
      inds.forEach(elem => {
        this.indexes[elem.path] = elem;
      });
    }
  }

  /**
   * Creates an index on the specified property.
   *
   * @public
   * @param {String} prop - property to create the index on. If an array or property keys, generates compound key based
   *                        on the property values, order matters.
   * @param {Object} options index options
   * @param {String} options.indexName - the index name to be used for lookup function name generation.
   *                                   - by default generated = require(property name.
   * @param {String} options.indexType - the index type. <code>'singe'</code> or <code>'array'</code>.
   *                                   - default: <code>'single'</code>
   * @param {String} options.refKeyCase - the casing for the reference document key. The default is to take
   *                                      value of the property as is, unmodified, to generate the reference document
   *                                      key. Use this to force reference document key casing. This will also allow
   *                                      you to to query via index function in case insensitive way.
   *                                      options: <code>'upper'</code> or <code>'lower'</code>
   *
   * @example <caption>Simple reference document</caption>
   * var userSchema = lounge.schema({
   *   firstName: String,
   *   lastName: String,
   *   username: String
   * })
   *
   * userSchema.index('username', { indexName: 'UserName' })
   * var User = lounge.model('User', userSchema)
   * // use User.findByUserName(username) to query
   *
   * @example <caption>Simple coumpund document</caption>
   * var userSchema = lounge.schema({
   *   email: String,
   *   username: String
   * })
   *
   * userSchema.index(['email', 'username'], { indexName: 'EmailAndUserName' })
   * var User = lounge.model('User', userSchema)
   * // use User.findByEmailAndUserName(email, username) to query
   */
  index(prop, options = {}) {
    const indexType = options.indexType || 'single';
    let indexName = options.indexName;
    let compound = false;
    if (Array.isArray(prop)) {
      if (!indexName) {
        let indexProps = _.map(prop, p => {
          if (trailingDigitReg.test(p)) {
            p = p[p.length - 2];
          }
          p = p.replace('.', '_');
          return inflection.singularize(p);
        });
        indexName = schemaUtils.getIndexName(indexProps);
      }
      compound = true;
    } else {
      if (!indexName) {
        indexName = prop;
        if (trailingDigitReg.test(indexName)) {
          indexName = indexName[indexName.length - 2];
        }

        indexName = inflection.singularize(indexName);
      }
    }

    const indexData = { path: prop, name: indexName, indexType: indexType, compound: compound };
    if (options.refKeyCase) {
      indexData.refKeyCase = options.refKeyCase;
    }

    this.indexes[indexName] = indexData;
  }

  /**
   * Creates a instance method for the created model.
   * An object of function names and functions can also be passed in.
   *
   * @public
   * @param {String} name the name of the method
   * @param {Function} func the actual function implementation
   *
   * @example
   * var userSchema = lounge.schema({
   *   firstName: String,
   *   lastName: String
   * })
   *
   * userSchema.method('getFullName', function () {
   *   return this.firstName + ' ' + this.lastName
   * })
   *
   * var User = lounge.model('User', userSchema)
   * var user = new User({
   *   firstName: 'Joe',
   *   lastName: 'Smith'
   * })
   *
   * console.log(user.getFullName()) // Joe Smith
   */
  method(name, func) {
    if (_.isPlainObject(name)) {
      for (func in name) {
        if ({}.hasOwnProperty.call(name, func)) {
          this.method(func, name[func]);
        }
      }
    } else {
      if (!_.isString(name)) {
        throw new TypeError('Schema#method expects a string identifier as a function name');
      } else if (!_.isFunction(func)) {
        throw new TypeError('Schema#method expects a function as a handle');
      }

      this.methods[name] = func;
    }
  }

  /**
   * Creates a static function or property for the created model.
   * An object of function or property names and functions or values can also be passed in.
   *
   * @public
   * @param {String} name name of the static property
   * @param {*} val the actual value or static function
   *
   * @example <caption>Create a static function</caption>
   * var userSchema = lounge.schema({ name: String })
   * userSchema.static('foo', function () {
   *   return 'bar'
   * })
   *
   * var User = lounge.model('User', userSchema)
   * console.log(User.foo()) // 'bar'
   *
   * @example <caption>Create a static property</caption>
   * var userSchema = lounge.schema({ name: String })
   * userSchema.static('FOO', 'bar')
   * var User = lounge.model('User', userSchema)
   * console.log(User.FOO) // 'bar'
   */
  static(name, func) {
    if (_.isPlainObject(name)) {
      for (func in name) {
        if ({}.hasOwnProperty.call(name, func)) {
          this.static(func, name[func]);
        }
      }
    } else {
      if (!_.isString(name)) {
        throw new TypeError('Schema#statics expects a string identifier as a function name');
      }

      this.statics[name] = func;
    }
  }

  /**
   * Creates a virtual property for the created model with the given object
   * specifying the get and optionally set function
   *
   * @public
   * @param {String} name name of the virtual property
   * @param {String|Function|Object} type optional type to be used for the virtual property. If not provided default is
   *                                      <code>'any'</code> type.
   * @param {Object} options virtual options
   * @param {Function} options.get - the virtual getter function
   * @param {Function} options.set - the virtual setter function. If not provided the virtual becomes read-only.
   *
   * @example
   * var userSchema = lounge.schema({firstName: String, lastName: String})
   *
   * userSchema.virtual('fullName', String, {
   *   get: function () {
   *     return this.firstName + ' ' + this.lastName
   *   },
   *   set: function (v) {
   *     if (v !== undefined) {
   *       var parts = v.split(' ')
   *       this.firstName = parts[0]
   *       this.lastName = parts[1]
   *     }
   *   }
   * })
   *
   * var User = lounge.model('User', userSchema)
   *
   * var user = new User({firstName: 'Joe', lastName: 'Smith'})
   * console.log(user.fullName) // Joe Smith
   * user.fullName = 'Bill Jones'
   * console.log(user.firstName) // Bill
   * console.log(user.lastName) // Jones
   * console.log(user.fullName) // Bill Jones
   */
  virtual(name, type, options) {
    if (!_.isString(name)) {
      throw new TypeError('Schema#virtual expects a string identifier as a property name');
    }

    if (_.isPlainObject(type) && !options) {
      options = type;
      type = 'any';
    } else if (!_.isPlainObject(options)) {
      throw new TypeError('Schema#virtual expects an object as a handle');
    } else if (!_.isFunction(options.get)) {
      throw new TypeError('Schema#virtual expects an object with a get function');
    }

    const virtualType = {
      type,
      virtual: true,
      get: options.get,
      invisible: true
    };

    if (options.set) {
      virtualType.set = options.set;
    } else {
      virtualType.readOnly = true;
    }

    this.descriptor[name] = virtualType;
  }

  /**
   * Sets/gets a schema option.
   *
   * @param {String} key option name
   * @param {Object} [value] if not passed, the current option value is returned
   * @public
   */
  set(key, value) {
    if (arguments.length === 1) {
      return this.options[key];
    }

    this.options[key] = value;

    return this;
  }

  /**
   * Gets a schema option.
   *
   * @public
   * @param {String} key option name
   * @return {*} the option value
   */
  get(key) {
    return this.options[key];
  }

  /**
   * Defines a pre hook for the schema.
   * See {@link https://www.github.com/bojand/grappling-hook grappling-hook}.
   */
  pre(name, fn) {
    this._hook('pre', name, fn);
  }

  /**
   * Defines a post hook for the schema.
   * See {@link https://www.github.com/bojand/grappling-hook grappling-hook}.
   */
  post(name, fn) {
    this._hook('post', name, fn);
  }

  _hook(hook, name, fn) {
    if (this.hooks[`${hook}:${name}`] && Array.isArray(this.hooks[`${hook}:${name}`].fns)) {
      this.hooks[`${hook}:${name}`].fns.push(fn);
    } else {
      this.hooks[`${hook}:${name}`] = {
        hook,
        name,
        fns: [fn]
      };
    }
  }

  /**
   * Adds the descriptor to the schema at the given key. Or add an <code>object</code> as a descriptor.
   * @param {String|Object }key the property key
   * @param {Object} descriptor the property descriptor
   *
   * @example
   * var userSchema = lounge.schema({firstName: String })
   * userSchema.add('lastName', String)
   * userSchema.add({ email: String })
   */
  add(key, descriptor) {
    if (!this.descriptor) {
      this.descriptor = {};
    }

    // adjust our descriptor
    if (key && descriptor) {
      this._getRefs(descriptor);
      this._getIndexes(descriptor, key);
      this.descriptor[key] = normalizeProperties.call(this, descriptor, key);
    } else if (typeof key === 'object' && !descriptor) {
      this._getRefs(key);
      this._getIndexes(key);

      _.each(key, (properties, index) => {
        this.descriptor[index] = normalizeProperties.call(this, properties, index);
      });
    }

    this._applyDocumentKey(this.descriptor);
  }

  /**
   * Clones property = require(other to us
   * @param {Schema} other - other schema
   * @param {String} prop - property name
   * @param {Boolean} add - whether to add() or assign. if true will do deep clone.
   * @private
   */
  _cloneProp(other, prop, add) {
    if (other && other[prop]) {
      let p;
      for (p in other[prop]) {
        if (other[prop].hasOwnProperty(p) && !this[prop][p]) {
          if (add) {
            this.add(p, clone(other.descriptor[p]));
          } else {
            this[prop][p] = other[prop][p];
          }
        }
      }
    }
  }

  /**
   * Extends other schema. Copies descriptor properties, methods, statics, virtuals and middleware.
   * If this schema has a named property already, the property is not copied.
   * @param {Schema} other the schema to extend.
   */
  extend(other) {
    if (other && other instanceof Schema) {
      this._cloneProp(other, 'descriptor', true);
      this._cloneProp(other, 'statics');
      this._cloneProp(other, 'methods');

      // options
      let k;
      for (k in other.options) {
        if (other.options.hasOwnProperty(k)) {
          const ours = this.get(k);
          const theirs = other.options[k];
          if (_.isUndefined(ours)) {
            this.set(k, clone(theirs));
          } else if (_.isPlainObject(ours) && _.isPlainObject(theirs)) {
            const dest = clone(theirs);
            this.set(k, _.merge(dest, ours));
          }
        }
      }

      _.forEach(_.values(other.hooks), hook => {
        _.forEach(hook.fns, fn => {
          this[hook.hook](hook.name, fn);
        });
      });
    }

    return this;
  }

  /**
   * Helper function to get the document key
   * @param {String} id the id
   * @param {Boolean} full If <code>true</code> the full expanded value of the key will be returned if there were any suffix and / or prefix
   * defined in schema they are also applied. We test if the passed in id already satisfies expansion.
   * @returns {String}
   * @example
   * var schema = lounge.schema({ email: String }, {keyPrefix: 'user::' })
   * console.log(schema.getDocumentKeyValue('114477a8-1901-4146-8c90-0fc9eec57a58', true)) // user::114477a8-1901-4146-8c90-0fc9eec57a58
   * console.log(schema.getDocumentKeyValue('user::114477a8-1901-4146-8c90-0fc9eec57a58', true)) // user::114477a8-1901-4146-8c90-0fc9eec57a58
   * console.log(schema.getDocumentKeyValue('user::114477a8-1901-4146-8c90-0fc9eec57a58', false)) // 114477a8-1901-4146-8c90-0fc9eec57a58
   * console.log(schema.getDocumentKeyValue('114477a8-1901-4146-8c90-0fc9eec57a58', false)) // 114477a8-1901-4146-8c90-0fc9eec57a58
   */
  getDocumentKeyValue(id, full) {
    if (_.isString(id)) {
      const prefix = _.isString(this.key.prefix) ? this.key.prefix : '';

      const suffix = _.isString(this.key.suffix) ? this.key.suffix : '';

      const prefixRX = escapeStringRegexp(prefix);
      const suffixRX = escapeStringRegexp(suffix);

      const re = new RegExp(`^${prefixRX}.*${suffixRX}$`);
      const test = re.test(id);

      if (full) {
        if (test) {
          if (typeof this.key.dynamicKey === 'function') {
            return this.key.dynamicKey(id);
          }
          return id;
        }

        if (typeof this.key.dynamicKey === 'function') {
          return this.key.dynamicKey(prefix.concat(id, suffix));
        }

        return prefix.concat(id, suffix);
      }

      if (test) {
        id = id.replace(new RegExp(`^${prefixRX}`), '');
        id = id.replace(new RegExp(`${suffixRX}$`), '');
      }
    }

    return id;
  }

  /**
   * Gets the reference document key value
   * @param {String} name - index name
   * @param {String} v - index value
   * @returns {string}
   */
  getRefKey(name, v) {
    const d = this.options.delimiter;
    let kp = this.options.keyPrefix || '';
    if (typeof this.options.dynamicKey === 'function') {
      kp = this.options.dynamicKey();
    }
    const index = this.indexes[name];
    if (index && index.refKeyCase === utils.REF_KEY_CASE.UPPER) {
      v = v.toUpperCase();
    } else if (index && index.refKeyCase === utils.REF_KEY_CASE.LOWER) {
      v = v.toLowerCase();
    }

    const fullPrefix = kp.concat(this.options.refIndexKeyPrefix || '', name, d);

    // Limit ref key length to Couchbase's max key length
    if (Buffer.byteLength(fullPrefix.concat(v)) > MAX_REF_KEY_LENGTH) {
      debug(`Hashing ref key value ${v} of type ${name}`);
      v = 'hashed_'.concat(
        crypto
          .createHash('md5')
          .update(v)
          .digest('hex')
      );
    }

    return fullPrefix.concat(v);
  }

  /**
   * Returns whether this schema has the specified reference path
   * @param {String} path path to check
   * @returns {boolean}
   */
  hasRefPath(path) {
    let ret = false;
    if (this.refs && path) {
      path = path.toLowerCase();
      for (const key in this.refs) {
        let resolvedPath = this.refs[key].path.toLowerCase();
        if (this.refs.hasOwnProperty(key) && resolvedPath === path) {
          ret = true;
          break;
        }
      }
    }

    return ret;
  }
}

module.exports = Schema;
