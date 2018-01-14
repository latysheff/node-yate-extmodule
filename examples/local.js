#!/usr/bin/node
const extmodule = require('../index')

let connection = extmodule.connect()

connection.setlocal('trackparam', 'badguy')
connection.setlocal('timeout', 100)

connection.watch('engine.timer', (message) => {
  connection.dispatch('my.timer', {'time': message.time - 10})
})

connection.subscribe('my.message', 200, (message) => {
  message.myparam = 'i change this'
  message.newparam = 'and this too'
  return 'bye'
})

// Yate will restart the script
setTimeout(process.exit, 30000)
