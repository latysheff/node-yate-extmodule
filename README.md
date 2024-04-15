# Node.js library for YATE (Yet Another Telephone Engine)

This Node.js module is a library for connecting external applications 
to [Yate] telephony engine. Details of control protocol are described [here][API]. 
Yate's extmodule documentation [here][extmodule].

Module supports local (piped) and socket operation modes. 
In socket mode one application can control many Yate instances, if needed.

## New API in version 1.0.0
* Breaking changes in subscribe() - listener returns string or nothing as retval; message considered as processed if function doesn't throw
* Breaking changes in dispatch() - callback signature matches (err, ...args)
* Breaking changes in 'decoration' - root member now called 'value', not repeated section name, like gt.gt, see below

## Installation
`npm install yate-extmodule`

## Usage
`const extmodule = require('yate-extmodule')`

## Features
Many things happen under the hood of this module to make developer's life easier.

Module automatically:

* reconnects in socket mode
* installs message hooks (re-subscribe) on every reconnect
* sets connection parameters on every reconnect
* acknowledges messages
* receives answers and matches them to dispatched messages
* 'decorates' messages (see below)
* if not connected to Yate, queues messages dispatched by application
and sends out later when socket becomes connected
* disables console output in piped mode (use file logger instead)

## Socket operation
Yate can start one or more socket listeners and wait for external programs to connect to them. Depending on the platform, TCP and UNIX sockets may be available.
Once connected, an external program uses this single socket to send commands and receive answers from the engine.

Example:
```
const extmodule = require('yate-extmodule')
let connection = extmodule.connect({host: '127.0.0.1', port: 5040}, () => {
  console.log('connected')
})
connection.watch('engine.timer', (message) => {
  console.log('tick', message.time)
})
```
See also examples directory

Example of Yate config file extmodule.conf
```
[listener external]
type=tcp
addr=0.0.0.0
port=5040
role=global
```

Module also supports UNIX sockets:
```
[listener unix]
type=unix
path=/tmp/extsocket
role=global
```

## Local piped mode

In this mode application runs locally and communicates with Yate through stdin/stdout file descriptors.
Such application is launched by Yate during startup or by internal command:
`external start local.js`

Local mode activates if neither port nor path are given to connect().

Example:
```
#!/usr/bin/node
const extmodule = require('yate-extmodule')
let connection = extmodule.connect(() => {
  console.log('connected')
})
connection.watch('engine.timer', (message) => {
  console.log('tick', message.time)
})
```

Example of Yate config file extmodule.conf
```
[scripts]
local.js=param
```

## Message decoration
Some Yate modules may send messages with dotted keys, 
obviously imitating nested structure of parameters.
Module can automatically convert nested objects according to this style.

Example:
```
{ 'CalledPartyAddress.route': 'gt',
  'CalledPartyAddress.pointcode': '2002',
  'CalledPartyAddress.gt.nature': 'international',
  'CalledPartyAddress.gt.plan': 'isdn',
  'CalledPartyAddress.gt.translation': '0',
  'CalledPartyAddress.gt.encoding': 'bcd',
  'CalledPartyAddress.gt': '2002',
  'CalledPartyAddress.ssn': '6' }

{ CalledPartyAddress: 
   { route: 'gt',
     pointcode: '2002',
     gt: 
      { nature: 'international',
        plan: 'isdn',
        translation: '0',
        encoding: 'bcd',
        value: '2002' },
     ssn: '6' } }
```

Decoration converts 'true' and 'false' values to boolean.

Decoration also auto-converts hex data in parameters (in form 'a0 b0', if length is 2 bytes or more) to Buffers and back.

## API

## Module 

### connect([options, ][connectListener])
Create new Connection(options, connectListener) and automatically connect to Yate.

## Connection

### Connection([options, ][connectListener])
Main Connection class.

* options [Object]
* connectListener [Function] Will be added as a listener for the 'connect' event.

Available options are:

* port [number] Port the socket should connect to. If absent, pipe mode activates.
* host [string] Host the socket should connect to. Default: '127.0.0.1'.
* reconnectTimeout [number] How much to wait until next attempt to connect. Default 500 ms.
* reconnect [boolean] Automatically reconnect. Default: true. Doesn't work in local mode.
* decorate [boolean] Enable or disable converting of dotted messages keys to objects. Default: true.
* parameters [object] Easy way to set various parameters of connection. See also setlocal().

Parameters:

* trackparam (string) - Set the message handler tracking name, cannot be made empty. Default: nodejs.
* timeout (int) - Timeout in milliseconds for answering to messages. Default: 10000 (10 sec).
* timebomb (bool) - Terminate this module instance if a timeout occured. Default: false.
* bufsize (int) - Length of the incoming line buffer (default 8192). Increase if high load is expected.
* reenter (bool) - If this module is allowed to handle messages generated by itself. Default: false
* selfwatch (bool) - If this module is allowed to watch messages generated by itself. Default: false
* restart (bool) - Restart this global module if it terminates unexpectedly.
Useful only in local mode, defaults to true.

Example:
```
const extmodule = require('yate-extmodule')
const config = {
  host: '127.0.0.1',
  port: 5040,
  reconnect: true,
  parameters: {
    reenter: true,
    timeout: 1000,
    bufsize: 32768
  }
}
const connection = extmodule.connect(config)
```

### Connection.connect()
Activate connection

### Connection.dispatch(name, [message, ][callback])
Send message to Yate for processing

* name - message name (string). Required.
* message - message parameters (object)
* callback - function called back when (and if) message returns from processing

Callback is optional, unless you care about the result of processing. 
If you do, here are arguments:

callback(err, retval, message)

* err - error (if not processed) or null
* retval - return value of the message
* message - updated message

### Connection.subscribe(name, [priority, ][filterParam, filterVal, ]listener)
Subscribe to process Yate messages having this name.

* name - Message name to which you subscribe (string). Required.
* priority - message priority (see docs). Default: 100.
* filterParam - receive only messages, which have filterParam=filterVal
* filterVal
* listener - Function that will be called every time when message received. Required. 

listener(message, retval) 

* message - received message
* retval - return value, that message may already have

Message is considered finalized ('processed') by default,
and return value of this listener function becomes 'retval'.
If application wants to indicate that message was not finalized,
function should return object with corresponding keys: 'processed' and 'retval'.
Nevertheless, object keys are all optional, and 'processed' key is again true by default.

Note: if you want to process your own dispatched messages,
don't forget to set Connection options.parameters.reenter = true

### Connection.unsubscribe(name)
Unsubscribe from messages having this name. 

* name - Message name from which you unsubscribe (string). Required.

### Connection.watch(name, listener)
Subscribe to watch Yate messages having this name.
You are not supposed to (and you can not) process message in this listener. Use subscribe for this.

Watching messages is different from subscribing to them:
this event is a post-dispatching notifier, i.e. message has final state.
 
* name - Message name (string). Required.
* listener - Function that will be called every time when watched message received. Required. 

Note: if you want to watch your own dispatched messages,
don't forget to set Connection options.parameters.selfwatch = true

### Connection.unwatch(name)
Stop watching messages having this name. 

* name - Message name from which you unsubscribe (string). Required.

### Connection.setlocal(name, value, callback)
Set connection parameter. See [External module command flow][API]

Result comes in callback(error, value)

Example:
```
connection.setlocal('timeout', 1000, false, (error, value) => {
  console.log(error, value)
})
```

### Connection.getlocal(name, callback)
Get connection or engine parameter.

Alias to setlocal(name, value, callback)

Example:
```
connection.getlocal('engine.configpath', (err, result) => {
  console.log(err, result)
})
```

### Connection.getconfig(section, key, callback)
Get configuration parameter of Yate main config file.

Result comes in callback(error, value)

Example:
```
connection.getconfig('modules', 'msgsniff.yate', (error, value) => {
  console.log(error, value)
})
```

### Connection.command(text, callback)
Send control command to Yate and get feedback

Result comes in callback(error, result)

Example:
```
connection.command('sniffer off', (err, result) => {
  console.log(err, result)
})
```

### Connection.arg
This property takes the value of argument supplied to executed script.
Equals to process.argv[2].

Example:
```
[scripts]
local.js=debug // connection.arg --> 'debug'
```

### Connection events
* connect - connected to Yate
* connecting - connect attempt (only tcp mode)
* disconnect - socket disconnect (only tcp mode)
* error - error on tcp socket or in command protocol

## Author
Copyright (c) 2016-2018 Vladimir Latyshev

License: MIT 

[YATE]: http://yate.ro/opensource.php
[API]: http://docs.yate.ro/wiki/External_module_command_flow
[extmodule]: http://docs.yate.ro/wiki/External_Module