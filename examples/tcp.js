const extmodule = require('../index')

let connection = extmodule.connect({
  host: '10.211.55.16',
  port: 5040,
  reconnect: true,
  parameters: {
    reenter: true,
    timeout: 1000,
    bufsize: 32768
  }
})

connection.on('connect', () => {
  console.log('connected')
})

connection.on('connecting', () => {
  console.log('connecting')
})

connection.on('disconnect', () => {
  console.log('disconnect')
})

connection.on('error', (error) => {
  console.log('error', error)
  connection.connect()
})

connection.subscribe('engine.command', 50, (message, retval) => {
  console.log('> sniffed command', message, retval)
  return {processed: false}
})

connection.getlocal('engine.logfile', (error, value) => {
  console.log(error, value)
})

connection.getconfig('modules', 'msgsniff.yate', (error, value) => {
  console.log(error, value)
})

connection.getconfig('telephony', 'number', (error, value) => {
  console.log(error, value)
})

connection.subscribe('my.message', 100, 'myparam', 'myvalue', (message, result) => {
  console.log('-> received my.message', message, result)
  message.myparam = 'newvalue'
  message.newparam = 'hello'
  return {retval: 'hi', processed: false}
})

connection.watch('my.message', (message, result) => {
  console.log('-> watched my.message', message, result)
})

connection.unwatch('my.message')

// connection.watch('engine.timer', (message) => {
//   console.log('tick', message.time)
// })

// connection.on('raw', (message) => {
//   console.log(message)
// })

connection.dispatch('my.message', {'myparam': 'myvalue'}, (result, message, processed) => {
  console.log('-> result =', result, message, processed)
})

connection.command('sniffer on', (err, result) => {
  console.log(err, result)
})

connection.command('sniffer filter my.message', (err, result) => {
  console.log(err, result)
})

connection.getlocal('engine.configpath', (err, result) => {
  console.log(err, result)
})
