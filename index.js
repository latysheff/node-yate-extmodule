/*

 Node.js library for YATE (Yet Another Telephone Engine)

 Copyright (c) 2016-2024 Vladimir Latyshev

 See https://docs.yate.ro/wiki/External_module_command_flow
 */

const net = require('net')
const events = require('events')
const readline = require('readline')

const DISPATCH_TIMEOUT = 10000

class Connection extends events.EventEmitter {
  constructor (options, connectListener) {
    super()

    if (typeof options === 'number') {
      options = { port: options }
    } else if (typeof options === 'function') {
      connectListener = options
    }

    options = options || {}
    this.path = options.path
    this.port = options.port
    this.host = options.host || '127.0.0.1'
    this.reconnectTimeout = options.reconnectTimeout || 500
    this.reconnect = options.reconnect !== false
    this.piped = !(this.port || this.path)
    this.decorate = options.decorate !== false

    this.parameters = options.parameters || {}
    for (const key in this.parameters) {
      validateLocalValue(key, this.parameters[key])
    }
    this.parameters.trackparam = this.parameters.trackparam || 'nodejs'

    if (this.piped) {
      this.in_stream = process.stdin
      this.out_stream = process.stdout
      this.parameters.restart = true
      console.log = console.dir = console.error = console.warn = function () {
      }
    } else {
      this.network = {
        path: this.path,
        port: this.port,
        host: this.host
      }
      process.on('SIGINT', () => {
        if (this.socket) {
          this.socket.end()
        }
        this.reconnect = false
        this.removeAllListeners()
        setTimeout(process.exit, 20)
      })
    }

    this.queue = []
    this.setlocalCallbacks = {}
    this.dispatchCallbacks = {}
    this.subscriptions = {}
    this.watchers = {}

    if (typeof connectListener === 'function') {
      this.on('connect', connectListener)
    }
  }

  connect (delay) {
    if (this.connected) return
    if (this.piped) {
      this.arg = process.argv[2]
      setTimeout(this._start.bind(this), 200)
    } else {
      if (this.reconnecting) return
      this.connecting = false
      this.reconnecting = true
      clearTimeout(this.timer)
      this.timer = setTimeout(this._connect.bind(this), ~~delay)
    }
  }

  dispatch (name, params, callback) {
    if (!((typeof name === 'string') && name)) {
      throw new Error('message name required')
    }
    const message = new Message(name, params)
    if (typeof callback === 'function') {
      this.dispatchCallbacks[message._id] = callback
      setTimeout(() => {
        if (message._id in this.dispatchCallbacks) { // still there
          callback(new Error('timeout'))
          delete this.dispatchCallbacks[message._id]
        }
      }, DISPATCH_TIMEOUT)
    }
    if (this.connected) {
      this._dispatch(message)
    } else {
      this.queue.push(message)
    }
    return message
  }

  setlocal (name, value, callback) {
    validateLocalValue(name, value)
    this.parameters[name] = value
    this.setlocalCallbacks[name] = callback
    if (this.connected) {
      this._setlocal(name, value)
    }
  }

  getlocal (name, callback) {
    this.setlocal(name, '', callback)
  }

  getconfig (section, key, callback) {
    this.getlocal('config.' + section + '.' + key, callback)
  }

  subscribe (name, priority, filterParam, filterVal, listener) {
    if (!((typeof name === 'string') && name)) {
      throw new Error('message name required')
    }
    if (typeof priority === 'function') {
      listener = priority
      priority = null
      filterParam = null
    } else {
      if (typeof filterParam === 'function') {
        listener = filterParam
        filterParam = null
      } else {
        if (typeof listener === 'function') {
          // ok
        } else {
          throw new Error('Listener is not a function')
        }
      }
    }
    priority = priority || ''
    if (!(/^\d{0,5}$/.test(priority))) {
      throw new Error(`priority ${priority} is invalid`)
    }
    if (this.subscriptions[name]) {
      throw new Error(`subscription to '${name}' already exists, unsubscribe first`)
    }
    this.subscriptions[name] = { name, priority, filterParam, filterVal, listener }
    if (this.connected) {
      this._install(name, priority, filterParam, filterVal)
    }
  }

  unsubscribe (name) {
    delete this.subscriptions[name]
    if (this.connected) {
      this._uninstall(name)
    }
  }

  watch (name, listener) {
    if (!((typeof name === 'string') && name)) {
      throw new Error('message name required')
    }
    if (typeof listener === 'function') {
      // ok
    } else {
      throw new Error('Listener is not a function')
    }
    if (!this.parameters.selfwatch) {
      this.parameters.selfwatch = true
      if (this.connected) {
        this.setlocal('selfwatch', true)
      }
    }
    if (this.watchers[name]) {
      throw new Error(`watcher to '${name}' already exists, unwatch first`)
    }
    this.watchers[name] = listener
    if (this.connected) {
      this._watch(name)
    }
  }

  unwatch (name) {
    delete this.watchers[name]
    if (this.connected) {
      this._unwatch(name)
    }
  }

  command (line, callback) {
    this.dispatch('engine.command', { line }, callback)
  }

  status (module, callback) {
    this.dispatch('engine.status', { module }, callback)
  }

  log (text) {
    this._output(text)
  }

  _connect () {
    if (this.connected) return
    if (this.connecting) return
    this.reconnecting = false
    this.connecting = true

    this.emit('connecting')
    this.socket = new net.Socket()

    this.socket.on('connect', () => {
      this.in_stream = this.out_stream = this.socket
      this._start()
    })

    this.socket.on('end', () => {
      this.connected = false
      this.emit('disconnect')
      if (this.reconnect) {
        this.connect(this.reconnectTimeout)
      }
    })

    this.socket.on('error', (error) => {
      this.connected = false
      if (this.reconnect) {
        this.connect(this.reconnectTimeout)
      } else {
        this.emit('error', error)
      }
    })

    this.timer = setTimeout(() => {
      if (this.reconnect) {
        this.connect(100)
      }
    }, this.reconnectTimeout)

    this.socket.connect(this.network)
  }

  _start () {
    if (this.connected) return
    clearTimeout(this.timer)
    this.connecting = false
    this.reconnecting = false
    this.connected = true

    const rl = readline.createInterface(this.in_stream)
    rl.on('line', (string) => {
      this._process(string)
    })
    rl.on('error', (error) => {
      this.emit('error', error)
    })

    // resend parameters
    for (const key in this.parameters) {
      this._setlocal(key, this.parameters[key])
    }

    // resubscribe
    for (const key in this.subscriptions) {
      const { name, priority, filterParam, filterVal } = this.subscriptions[key]
      this._install(name, priority, filterParam, filterVal)
    }

    // reinstall watchers
    for (const name in this.watchers) {
      const callback = this.watchers[name]
      this._watch(name, callback)
    }

    // send queued messages
    this.queue.forEach((message) => {
      this._dispatch(message)
    })
    this.queue = []

    this.emit('connect')
  }

  _process (string) {
    this.emit('raw', '< ' + string)
    const message = new Message()
    message.parse(string, this.decorate)
    if (message.error) {
      this.emit('error', new Error(message.error))
      return
    }
    if (message._type === 'setlocal') {
      const callback = this.setlocalCallbacks[message._name]
      if (typeof callback === 'function') {
        const err = message._success ? null : new Error(`not processed ${message._type} ${message._name}`)
        callback(err, message._value)
        delete this.setlocalCallbacks[message._name]
      }
    } else if (message._type === 'notification') {
      const listener = this.watchers[message._name]
      if (typeof listener === 'function') {
        listener(message.params, message._retval)
      }
    } else if (message._type === 'answer') {
      const callback = this.dispatchCallbacks[message._id]
      if (typeof callback === 'function') {
        const err = message._processed ? null : new Error('not processed')
        const retval = message._retval ? message._retval.trim() : null
        callback(err, retval, message.params)
        delete this.dispatchCallbacks[message._id]
      }
    } else {
      const subscription = this.subscriptions[message._name]
      if (!subscription) return
      switch (message._type) {
        case 'install':
          // confirmation for subscription ("install")
          if (!message._success) {
            delete this.subscriptions[subscription.name]
            this.emit('warning', new Error(`not subscribed ${subscription.name}`))
          }
          break
        case 'incoming':
          if (typeof subscription.listener === 'function') {
            try {
              // note: any existing retval also passed to listener
              message._retval = subscription.listener(message.params, message._retval)
              message._processed = true
            } catch {
              // todo debug
            }
            this._acknowledge(message)
          }
          break
      }
    }
  }

  _acknowledge (message) {
    // %%<message:<id>:<processed>:[<name>]:<retvalue>[:<key>=<value>...]
    if (message._type !== 'incoming') return
    const string = '%%<message:' + escape(message._id) +
      ':' + Bool2str(message._processed) +
      '::' + escape(message._retval) +
      message.stringify(true, this.decorate)
    this._send(string)
    message._type = 'acknowledged'
  }

  _dispatch (message) {
    // %%>message:<id>:<time>:<name>:<retvalue>[:<key>=<value>...]
    if (message._type !== 'outgoing') return
    const string = '%%>message:' + escape(message._id) +
      ':' + message._origin +
      ':' + escape(message._name) +
      ':' + message.stringify(false, this.decorate)
    this._send(string)
    message._type = 'enqueued'
  }

  _install (name, priority, filter, filterval) {
    // %%>install:[<priority>]:<name>[:<filter-name>[:<filter-value>]]
    if (filter && filterval) {
      this._send('%%>install:' + priority + ':' + escape(name) + ':' + filter + ':' + filterval)
    } else {
      this._send('%%>install:' + priority + ':' + escape(name))
    }
  }

  _uninstall (name) {
    // %%>uninstall:<name>
    this._send('%%>uninstall:' + name)
  }

  _watch (name) {
    // %%>watch:<name>
    this._send('%%>watch:' + name)
  }

  _unwatch (name) {
    // %%>unwatch:<name>
    this._send('%%>unwatch:' + name)
  }

  _output (string) {
    // %%>output:arbitrary unescaped string
    ('' + string).split('\n').forEach((string) => {
      this._send('%%>output:' + string)
    })
  }

  _setlocal (name, value) {
    // %%>setlocal:<name>:<value>
    this._send('%%>setlocal:' + name + ':' + value)
  }

  _send (string) {
    this.emit('raw', '> ' + string)
    if (this.out_stream) {
      this.out_stream.write(string + '\n')
    }
  }
}

class Message {
  constructor (name, params) {
    this._name = name
    this._origin = Math.floor(Date.now() / 1000).toString()
    this._id = this._origin + process.hrtime()[1]
    this._type = 'outgoing'
    this._processed = false
    this.params = params || {}
  }

  parse (string, decorate) {
    const dataArray = string.split(':')
    switch (dataArray[0]) {
      case '%%>message':
        // %%>message:<id>:<time>:<name>:<retvalue>[:<key>=<value>...]
        this._type = 'incoming'
        this._id = dataArray[1]
        this._origin = dataArray[2]
        this._name = dataArray[3]
        this._retval = unescape(dataArray[4])
        break
      case '%%<message':
        // %%<message:<id>:<processed>:[<name>]:<retvalue>[:<key>=<value>...]
        this._id = dataArray[1]
        this._type = this._id ? 'answer' : 'notification'
        this._processed = Str2bool(dataArray[2])
        this._name = dataArray[3]
        this._retval = unescape(dataArray[4])
        break
      case '%%<install':
        // %%<install:<priority>:<name>:<success>
        this._type = 'install'
        this._priority = dataArray[1]
        this._name = dataArray[2]
        this._success = Str2bool(dataArray[3])
        break
      case '%%<uninstall':
        // %%<uninstall:<priority>:<name>:<success>
        this._type = 'uninstall'
        this._priority = dataArray[1]
        this._name = dataArray[2]
        this._success = dataArray[3]
        break
      case '%%<watch':
        // %%<watch:<name>:<success>
        this._type = 'watch'
        this._name = dataArray[1]
        this._success = Str2bool(dataArray[2])
        break
      case '%%<setlocal':
        // %%<setlocal:<name>:<value>:<success>
        this._type = 'setlocal'
        this._name = dataArray[1]
        this._value = dataArray[2]
        this._success = Str2bool(dataArray[3])
        break
      case 'Error in':
        this.error = 'string'
        return
      default:
        this.error = `Unknown command from server: [${string}]`
        return
    }
    if (this._type === 'incoming' || this._type === 'answer' || this._type === 'notification') {
      dataArray.slice(5).forEach((item) => {
        const pos = item.indexOf('=')
        if (pos > 0) {
          const key = item.substr(0, pos)
          if (!(key in Message.prototype)) {
            this.params[unescape(key)] = unescape(item.substr(pos + 1))
          }
        }
      })
      if (decorate) {
        this.params = beautify(this.params)
      }
    }
  }

  stringify (includeEmpty, decorate) {
    if (decorate) {
      this.params = yatefy(this.params)
    }
    let result = ''
    for (const key in this.params) {
      const value = this.params[key].toString()
      if (value) {
        result += ':' + escape(key) + '=' + escape(value)
      } else if (includeEmpty) {
        result += ':' + escape(key)
      }
    }
    return result
  }
}

function escape (str, extra) {
  if (str === null) { return '' }
  if (str === undefined) { return 'undefined' }
  if (str === true) { return 'true' }
  if (str === false) { return 'false' }
  str = str.toString()
  let res = ''
  for (let idx = 0; idx < str.length; idx++) {
    let chr = str.charAt(idx)
    if ((chr.charCodeAt(0) < 32) || (chr === ':') || (chr === extra)) {
      chr = String.fromCharCode(chr.charCodeAt(0) + 64)
      res += '%'
    } else if (chr === '%') {
      res += chr
    }
    res += chr
  }
  return res
}

function unescape (str) {
  let res = ''
  for (let idx = 0; idx < str.length; idx++) {
    let chr = str.charAt(idx)
    if (chr === '%') {
      idx++
      chr = str.charAt(idx)
      if (chr !== '%') { chr = String.fromCharCode(chr.charCodeAt(0) - 64) }
    }
    res += chr
  }
  return res
}

function Bool2str (bool) {
  return bool ? 'true' : 'false'
}

function Str2bool (str) {
  return (str === 'true')
}

function yatefy (object, rootkey) {
  const result = {}
  const prefix = rootkey ? rootkey + '.' : ''

  for (const key in object) {
    let value = object[key]

    if (Buffer.isBuffer(value)) {
      value = hexlify(value)
    }

    if (typeof value === 'object' && value !== null) {
      const subobject = yatefy(value, key)
      for (const subkey in subobject) {
        result[prefix + subkey] = subobject[subkey]
      }
    } else {
      if (key === 'value') {
        result[rootkey] = value
      } else {
        result[prefix + key] = value
      }
    }
  }
  return result
}

function hexlify (byteArray, joiner = ' ') {
  return Array.from(byteArray, function (byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2)
  }).join(joiner)
}

function beautify (object) {
  const result = {}
  for (const key in object) {
    let value = object[key]

    if (value === 'false') {
      value = false
    } else if (value === 'true') {
      value = true
    } else if (value.length > 4 && value.match(/[0-9a-f]{2}( [0-9a-f]{2})+/g)) {
      value = unhexlify(value)
    }

    if (key.indexOf('.')) {
      key.split('.').reduce((object, key, index, arr) => {
        if (index === arr.length - 1) {
          if (typeof object === 'object' && key in object) {
            object[key].value = value
          } else {
            object[key] = value
          }
        } else {
          if (typeof object === 'object' && key in object) {
            if (typeof object[key] !== 'object') {
              object[key] = { [key]: object[key] }
            }
          } else {
            object[key] = {}
          }
        }
        return object[key]
      }, result)
    } else {
      result[key] = value
    }
  }
  return result
}

function unhexlify (str) {
  return Buffer.from(str.replace(/ /g, ''), 'hex')
}

/*
https://docs.yate.ro/wiki/External_module_command_flow#Format_of_commands_and_notifications
 */

const LOCAL_PARAMETERS = {
  id: 'string',
  disconnected: 'boolean',
  trackparam: 'string',
  reason: 'string',
  timeout: 'number',
  timebomb: 'boolean',
  bufsize: 'number',
  setdata: 'boolean',
  reenter: 'boolean',
  selfwatch: 'boolean',
  restart: 'boolean'
}

const ENGINE_PARAMETERS = {
  version: 'string',
  release: 'string',
  nodename: 'string',
  runid: 'number',
  configname: 'string',
  sharedpath: 'string',
  configpath: 'string',
  cfgsuffix: 'string',
  modulepath: 'string',
  modsuffix: 'string',
  logfile: 'string',
  clientmode: 'boolean',
  supervised: 'boolean',
  maxworkers: 'number'
}

function validateLocalValue (key, value) {
  if (!value) {
    const matchEngineParams = key.match(/^engine\.(.*)/)
    if (matchEngineParams) {
      const [, param] = matchEngineParams
      if (param in ENGINE_PARAMETERS) {
        return
      }
    } else {
      const matchConfigSections = key.match(/^config\./)
      if (matchConfigSections) {
        return
      }
    }
  }
  if (!LOCAL_PARAMETERS[key]) {
    throw new Error(`unknown local parameter "${key}"`)
  }
  const parameterType = LOCAL_PARAMETERS[key]
  // eslint-disable-next-line valid-typeof
  if (typeof value !== parameterType) {
    throw new Error(`local parameter ${key} should be of type ${parameterType}`)
  }
}

function connect (options, connectListener) {
  const connection = new Connection(options, connectListener)
  connection.connect()
  return connection
}

module.exports = {
  connect,
  Connection,
  Message
}
