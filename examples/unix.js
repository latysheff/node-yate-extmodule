const extmodule = require('../index')

const connection = extmodule.connect({
  path: '/tmp/extsocket',
  reconnect: true
})

connection.on('connect', () => {
  console.log('connected unix socket')
})

connection.on('connecting', () => {
  console.log('connecting')
})

connection.on('disconnect', () => {
  console.log('disconnect')
})

connection.on('error', (error) => {
  console.log('error', error)
})
