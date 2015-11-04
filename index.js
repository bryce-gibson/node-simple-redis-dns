'use strict';

const DEFAULTS = {
  tcpPort: 53
  , udpPort: 53
  , logging: {
    type: 'Console'
    , level: 'silly'
    , handleExceptions: true
    , humanReadableUnhandledException: true
  }
  , redis: {
    showFriendlyErrorStack: true
  }
}

var Promise = require('bluebird')
  , net = require('net')
  , dns = require('native-dns')
  , program = require('commander')
  , Redis = require('ioredis')
  , rc = require('rc')
  , conf = rc('simple-redis-dns', DEFAULTS)
  , _ = require('lodash')
  , winston = require('winston')
  , logger = winston // to allow refactoring
  , getId = () => _.uniqueId('req_')
  , EXIT_SIGNALS = [ 'SIGINT', 'SIGTERM' ]

winston.remove(winston.transports.Console)
winston.add(winston.transports[conf.logging.type], conf.logging) // TODO

try {
  const Uuid = require('node-time-uuid')
  getId = () => new Uuid().toString('pretty')
} catch (undefined) {}

logger.silly('Starting up with config:', conf)

function initialShutdownHook() {
  logger.info(`Exiting because of ${signal}.`)
  process.exit(0)
}

_.each( EXIT_SIGNALS, (signal) => process.on(signal, initialShutdownHook) )

program
  .version('0.0.1')
  .command('server')
  .alias('s')
  .description('run dns server')
  .option('-u, --udp-port [port]', 'udp port to listen on')
  .option('-t, --tcp-port [port]', 'tcp port to listen on')
  .action( (options) => {
    _.defaults(options, conf)
    const udpServer = dns.createServer()
      , tcpServer = dns.createTCPServer()
      , servers = [ udpServer, tcpServer ]
      , redis = new Redis(options.redis)

    logger.debug('Will start servers.')

    function onRequest(req, res) {
      const type = dns.consts.QTYPE_TO_NAME[req.question[0].type]
        , name = req.question[0].name
        , stream = redis.sscanStream(`${type}:${name}`)

      req.id = getId()

      logger.profile(req.id)
      logger.debug('%s: Request received.', req.id, { type, name })

      stream.on('data', (results) => {
        _.each(results, (result) => {
          res.answer.push(dns[type]({
            name: name,
            address: result,
            ttl: 0
          }))
        })
      })

      stream.on('end', () => {
        logger.debug('%s: Responding.', req.id)
        res.send()
        logger.profile(req.id)
      })
      stream.on('error', (err) => {
        logger.debug('%s: Error processing request.', req.id, err)
        res.send()
        logger.profile(req.id)
      })
    }

    function onError(err, buff, req, res) {
      logger.error('Error whilst processing request.', err)
    }

    _.each(servers, (s) => {
      s.on('request', onRequest)
      s.on('error', onError)
    })

    if(options.udpPort) {
      logger.info('Starting udp server on %s.', options.udpPort)
      udpServer.serve(options.udpPort)
    }
    if(options.tcpPort) {
      logger.info('Starting tcp server on %s.', options.tcpPort)
      tcpServer.serve(options.tcpPort)
    }
    _.each( EXIT_SIGNALS, (signal) => {
        process.removeListener(signal, initialShutdownHook)
        process.on(signal, () => {
          udpServer.close()
          tcpServer.close()
          logger.info(`Exiting because of ${signal}.`)
          process.exit(0)
        })
      })
  })

function parseRecord(records, _result) {
  const result = _result == null ? [] : _result
    , field = records[records.length - 1]
  console.log('parseRecord ' + result.length + ' ' + field)
  if(field == null) return []
  if( dns.consts.NAME_TO_QTYPE[field.toUpperCase()] ) return [ field.toUpperCase() ].concat(result)
  return parseRecord(_.initial(records), [ field ].concat(result))
}

function parseRecords(records) {
  let result
    , results = []

  while(records.length) {
    result = parseRecord(records)
    let slice = records.length - result.length
    results = results.concat( [ result ] )
    slice = slice < 0 ? 0 : slice
    records = records.slice(0, slice)
  }
  return results
}
program
  .command('add <record...>')
  .alias('a')
  .description('add dns entries')
  .option('-t, --todo, not sure...')
  .action( (toAdd, options) => {
    _.defaults(options, conf)
    const redis = new Redis(options.redis)
      , recordsToAdd = parseRecords(toAdd)

    logger.info('Adding entries.', recordsToAdd)

    let promises = _.map(recordsToAdd, (record) => {
      const type = record[0]
        , args = record.slice(1)
        , domains = _.dropRightWhile(args, net.isIP)
        , ips = args.slice(domains.length)

      return _(domains)
        .map( (domain) => _.map(ips, (ip) => redis.sadd(`${type}:${domain}`, ip) ) )
        .flatten()
        .value()
    })

    Promise.all(promises)
      .then( () => logger.info('Records added.') )
      .catch( (err) => logger.error('Error adding records.', err) )
      .then( () => redis.quit() )
  })

program
  .command('remove <record...>')
  .alias('r')
  .description('remove dns entries')
  .option('-t, --todo, not sure...')
  .action( (toRemove, options) => {
    _.defaults(options, conf)
    const redis = new Redis(options.redis)
      , recordsToRemove = parseRecords(toRemove)

    logger.info('Removing entries.', recordsToRemove)

    let promises = _.map(recordsToRemove, (record) => {
      const type = record[0]
        , args = record.slice(1)
        , domains = _.dropRightWhile(args, net.isIP)
        , ips = args.slice(domains.length)

      return _(domains)
        .map( (domain) => _.map(ips, (ip) => redis.srem(`${type}:${domain}`, ip)) )
        .flatten()
        .value()
    })

    Promise.all(promises)
      .then( () => logger.info('Records removed.') )
      .catch( (err) => logger.error('Error removing records.', err) )
      .then( () => redis.quit() )
  })

program.on('--help', () => {
  console.log('  Examples:')
  console.log('')
  console.log('    $ redis-dns server')
  console.log('    $ redis-dns add A redis-dns.com 127.0.0.1 CNAME www.redis-dns.com redis-dns.com')
  console.log('')
  console.log('  Record:')
  console.log('    <type> <name...> <ip...>')
})

if(!process.argv.slice(2).length) {
  program.outputHelp()
}
program.parse(process.argv)
