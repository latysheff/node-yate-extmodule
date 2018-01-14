/*

 Node.js library for YATE (Yet Another Telephone Engine)

 Copyright (c) 2016-2018 Vladimir Latyshev

 */

const net = require('net')
const events = require('events')
const readline = require('readline')

class Connection extends events.EventEmitter {
  constructor(options, connectListener) {
    super()

    if (typeof options === 'number') {
      options = {port: options}
    } else if (typeof options === 'function') {
      connectListener = options
    }

    options = options || {}
    this.path = options.path
    this.port = options.port
    this.host = options.host || '127.0.0.1'
    this.timeout = options.timeout || 500
    this.reconnect = ('reconnect' in options) ? options.reconnect : true
    this.piped = !(this.port || this.path)
    this.console = !!options.console
    this.decorate = options.decorate || true
    this.parameters = options.parameters || {}
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
    this.setlocals = {}
    this.handlers = {}
    this.subscriptions = {}
    this.watchers = {}

    if (typeof connectListener === 'function') {
      this.on('connect', connectListener)
    }
  }

  connect(delay) {
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

  dispatch(name, params, callback) {
    if (!((typeof name === 'string') && name)) {
      throw new Error('message name required')
    }
    let message = new Message(name, params)
    this.handlers[message._id] = callback
    if (this.connected) {
      this._dispatch(message)
    } else {
      this.queue.push(message)
    }
    return message
  }

  setlocal(name, value, callback) {
    this.parameters[name] = value
    this.setlocals[name] = callback
    if (this.connected) {
      this._setlocal(name, value)
    }
  }

  getlocal(name, callback) {
    this.setlocal(name, '', callback)
  }

  getconfig(section, key, callback) {
    this.getlocal('config.' + section + '.' + key, callback)
  }

  subscribe(name, priority, filterParam, filterVal, listener) {
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
    this.subscriptions[name] = {name, priority, filterParam, filterVal, listener}
    if (this.connected) {
      this._install(name, priority, filterParam, filterVal)
    }
  }

  unsubscribe(name) {
    delete this.subscriptions[name]
    if (this.connected) {
      this._uninstall(name)
    }
  }

  watch(name, listener) {
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

  unwatch(name) {
    delete this.watchers[name]
    if (this.connected) {
      this._unwatch(name)
    }
  }

  command(text, callback) {
    this.dispatch('engine.command', {line: text}, (result, message, processed) => {
      callback(!processed, result.slice(0, -2))
    })
  }

  log(text) {
    this._output(text)
  }

  _connect() {
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
        this.connect(this.timeout)
      }
    })

    this.socket.on('error', (error) => {
      this.connected = false
      if (this.reconnect) {
        this.connect(this.timeout)
      } else {
        this.emit('error', error)
      }
    })

    this.timer = setTimeout(() => {
      if (this.reconnect) {
        this.connect(100)
      }
    }, this.timeout)

    this.socket.connect(this.network)
  }

  _start() {
    if (this.connected) return
    clearTimeout(this.timer)
    this.connecting = false
    this.reconnecting = false
    this.connected = true
    let rl = readline.createInterface(this.in_stream)
    rl.on('line', (string) => {
      this._process(string)
    })
    for (let key in this.parameters) {
      this._setlocal(key, this.parameters[key])
    }
    for (let key in this.subscriptions) {
      let subscription = this.subscriptions[key]
      let {name, priority, filterParam, filterVal} = subscription
      this._install(name, priority, filterParam, filterVal)
    }
    for (let name in this.watchers) {
      let watcher = this.watchers[name]
      this._watch(name, watcher)
    }
    this.queue.forEach((message) => {
      this._dispatch(message)
    })
    this.queue = []
    this.emit('connect')
  }

  _process(string) {
    this.emit('raw', '< ' + string)
    let message = new Message()
    message.parse(string, this.decorate)
    if (message.error) {
      this.emit('error', new Error(message.error))
      return
    }
    if (message._type === 'setlocal') {
      let setlocal = this.setlocals[message._name]
      if (typeof setlocal === 'function') {
        setlocal(!message._success, message._value)
        delete this.setlocals[message._name]
      }
    } else if (message._type === 'notification') {
      let watcher = this.watchers[message._name]
      if (watcher) {
        watcher(message.params, message._retval)
      }
    } else if (message._type === 'answer') {
      let handler = this.handlers[message._id]
      if (typeof handler === 'function') {
        handler(message._retval, message.params, message._processed)
        delete this.handlers[message._id]
      }
    } else {
      let subscription = this.subscriptions[message._name]
      if (!subscription) return
      switch (message._type) {
        case 'install':
          let name = subscription.name
          let callback = subscription.callback
          if (!message._success) {
            delete this.subscriptions[name]
          }
          if (typeof callback === 'function') {
            callback(!message._success, message._priority)
          }
          break
        case 'incoming':
          let listener = subscription.listener
          if (typeof listener === 'function') {
            let result = listener(message.params, message._retval)
            if (typeof result !== 'object') {
              result = {retval: result}
            }
            message._processed = ('processed' in result) ? result.processed : true
            message._retval = result.retval || message._retval || ''
            this._acknowledge(message)
          }
          break
      }
    }
  }

  _acknowledge(message) {
    // %%<message:<id>:<processed>:[<name>]:<retvalue>[:<key>=<value>...]
    if (message._type !== 'incoming') return
    let string = '%%<message:' + escape(message._id)
      + ':' + Bool2str(message._processed)
      + '::' + escape(message._retval)
      + message.stringify(true, this.decorate)
    this._send(string)
    message._type = 'acknowledged'
  }

  _dispatch(message) {
    // %%>message:<id>:<time>:<name>:<retvalue>[:<key>=<value>...]
    if (message._type !== 'outgoing') return
    let string = '%%>message:' + escape(message._id)
      + ':' + message._origin
      + ':' + escape(message._name)
      + ':' + message.stringify(false, this.decorate)
    this._send(string)
    message._type = 'enqueued'
  }

  _install(name, priority, filter, filterval) {
    // %%>install:[<priority>]:<name>[:<filter-name>[:<filter-value>]]
    if (filter && filterval) {
      this._send('%%>install:' + priority + ':' + escape(name) + ':' + filter + ':' + filterval)
    } else {
      this._send('%%>install:' + priority + ':' + escape(name))
    }
  }

  _uninstall(name) {
    // %%>uninstall:<name>
    this._send('%%>uninstall:' + name)
  }

  _watch(name) {
    // %%>watch:<name>
    this._send('%%>watch:' + name)
  }

  _unwatch(name) {
    // %%>unwatch:<name>
    this._send('%%>unwatch:' + name)
  }

  _output(string) {
    // %%>output:arbitrary unescaped string
    ('' + string).split('\n').forEach((string) => {
      this._send('%%>output:' + string)
    })
  }

  _setlocal(name, value) {
    // %%>setlocal:<name>:<value>
    this._send('%%>setlocal:' + name + ':' + value)
  }

  _send(string) {
    this.emit('raw', '> ' + string)
    if (this.out_stream) {
      this.out_stream.write(string + '\n')
    }
  }
}

class Message {
  constructor(name, params) {
    this._name = name
    this._origin = Math.floor(Date.now() / 1000).toString()
    this._id = this._origin + process.hrtime()[1]
    this._type = 'outgoing'
    this._processed = false
    this.params = params || {}
  }

  parse(string, decorate) {
    let data_array = string.split(':')
    switch (data_array[0]) {
      case '%%>message':
        // %%>message:<id>:<time>:<name>:<retvalue>[:<key>=<value>...]
        this._type = 'incoming'
        this._id = data_array[1]
        this._origin = data_array[2]
        this._name = data_array[3]
        this._retval = unescape(data_array[4])
        break
      case '%%<message':
        // %%<message:<id>:<processed>:[<name>]:<retvalue>[:<key>=<value>...]
        this._id = data_array[1]
        this._type = this._id ? 'answer' : 'notification'
        this._processed = Str2bool(data_array[2])
        this._name = data_array[3]
        this._retval = unescape(data_array[4])
        break
      case '%%<install':
        // %%<install:<priority>:<name>:<success>
        this._type = 'install'
        this._priority = data_array[1]
        this._name = data_array[2]
        this._success = Str2bool(data_array[3])
        break
      case '%%<uninstall':
        // %%<uninstall:<priority>:<name>:<success>
        this._type = 'uninstall'
        this._priority = data_array[1]
        this._name = data_array[2]
        this._success = data_array[3]
        break
      case '%%<watch':
        // %%<watch:<name>:<success>
        this._type = 'watch'
        this._name = data_array[1]
        this._success = Str2bool(data_array[2])
        break
      case '%%<setlocal':
        // %%<setlocal:<name>:<value>:<success>
        this._type = 'setlocal'
        this._name = data_array[1]
        this._value = data_array[2]
        this._success = Str2bool(data_array[3])
        break
      case 'Error in':
        this.error = 'string'
        return
      default:
        this.error = `Unknown command from server: [${string}]`
        return
    }
    if (this._type === 'incoming' || this._type === 'answer' || this._type === 'notification') {
      data_array.slice(5).forEach((item) => {
        let pos = item.indexOf('=')
        if (pos > 0) {
          let key = item.substr(0, pos)
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

  stringify(includeEmpty, decorate) {
    if (decorate) {
      this.params = yatefy(this.params)
    }
    let result = ''
    for (let key in this.params) {
      let value = this.params[key].toString()
      if (value) {
        result += ':' + escape(key) + '=' + escape(value)
      } else if (includeEmpty) {
        result += ':' + escape(key)
      }
    }
    return result
  }
}


function escape(str, extra) {
  if (str === null)
    return ''
  if (str === undefined)
    return 'undefined'
  if (str === true)
    return 'true'
  if (str === false)
    return 'false'
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


function unescape(str) {
  let res = ''
  for (let idx = 0; idx < str.length; idx++) {
    let chr = str.charAt(idx)
    if (chr === '%') {
      idx++
      chr = str.charAt(idx)
      if (chr !== '%')
        chr = String.fromCharCode(chr.charCodeAt(0) - 64)
    }
    res += chr
  }
  return res
}


function Bool2str(bool) {
  return bool ? 'true' : 'false'
}


function Str2bool(str) {
  return (str === 'true')
}


function yatefy(object, rootkey) {
  let result = {}
  let prefix = rootkey ? rootkey + '.' : ''
  for (let key in object) {
    if (typeof object[key] === 'object') {
      let subobject = yatefy(object[key], key)
      for (let subkey in subobject) {
        result[prefix + subkey] = subobject[subkey]
      }
    } else {
      let value = object[key].toString()
      if (rootkey === key) {
        result[key] = value
      } else {
        result[prefix + key] = value
      }
    }
  }
  return result
}


function beautify(object) {
  let result = {}
  for (let key in object) {
    let value = object[key]
    if (value === 'false') {
      value = false
    } else if (value === 'true') {
      value = true
    }
    if (key.indexOf('.')) {
      key.split('.').reduce((object, key, index, arr) => {
        if (index === arr.length - 1) {
          if (typeof object === 'object' && key in object) {
            object[key][key] = value
          } else {
            object[key] = value
          }
        } else {
          if (typeof object === 'object' && key in object) {
            if (typeof object[key] !== 'object') {
              object[key] = {[key]: object[key]}
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


function connect(options, connectListener) {
  let connection = new Connection(options, connectListener)
  connection.connect()
  return connection
}


if (process.platform === 'win32') {
  let rl = readline.createInterface(process.stdin, process.stdout)
  rl.on('SIGINT', () => {
    process.emit('SIGINT')
  })
}


module.exports = {
  connect,
  Connection,
  Message
}