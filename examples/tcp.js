const extmodule = require('../index')

const connection = extmodule.connect({
  host: '192.168.31.182',
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
  return { processed: false }
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

connection.subscribe('my.message', 100, 'myparam', 'myvalue', (message, retval) => {
  console.log('-> received my.message', message, retval)
  message.myparam = 'newvalue'
  message.newparam = 'hello'
  return 'hi'
})

connection.watch('my.message', (message, result) => {
  console.log('-> watched my.message', message, result)
})

connection.unwatch('my.message')

// connection.watch('engine.timer', (message) => {
//   console.log('tick', message.time)
// })

connection.on('raw', (message) => {
  console.log(message)
})

connection.dispatch('empty.message.with.no.callback')

connection.dispatch('my.message', { myparam: 'myvalue' }, (err, retval, message) => {
  if (err) {
    console.error(err)
    return
  }
  console.log('-> result =', retval, message)
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
