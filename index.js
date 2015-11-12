'use strict';

const DEFAULTS = {
  tcpPort: 53
  , udpPort: 53
  , logging: {
    type: 'Console'
    , level: 'info'
    , handleExceptions: true
    , humanReadableUnhandledException: true
  }
  , redis: {
    showFriendlyErrorStack: true
  }
}

const exit = () => process.exit(0)
process.on('SIGINT', exit)
process.on('SIGTERM', exit)

var Promise = require('bluebird')
  , fs = Promise.promisifyAll(require('fs'))
  , net = require('net')
  , dns = require('native-dns')
  , program = require('commander')
  , Redis = require('ioredis')
  , rc = require('rc')
  , conf = rc('simpleredisdns', DEFAULTS)
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

function initialShutdownHook(signal) {
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

      req.id = getId()
      logger.profile(req.id)
      logger.debug('%s: Request received.', req.id, { type, name })

      redis.lookup(type, name)
        .then( (results) => {

          _.each(results, (result) => {
            let recordType = result[0]
              , recordName = result[1] || name
              , address = result[2]
              , data = result[3]

            res.answer.push(dns[recordType]({
              name: recordName
              , address: address
              , data: data
              , ttl: 0
            }))
          })
          logger.debug('%s: Responding.', req.id)
          res.send()
          logger.profile(req.id)
        })
        .catch( (err) => {
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

    fs.readFileAsync('lookup.lua', 'utf8').then( (lookup) => {
      redis.defineCommand('lookup', {
        numberOfKeys: 2
        , lua: lookup
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
  })

function parseRecord(records, _result) {
  const result = _result == null ? [] : _result
    , field = records[records.length - 1]

  logger.silly('parseRecord ' + result.length + ' ' + field)
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
  .action( (toAdd, options) => {
    _.defaults(options, conf)
    const redis = new Redis(options.redis)
      , recordsToAdd = parseRecords(toAdd)

    logger.info('Adding entries.', recordsToAdd)

    redis.on('error', (err) => {
      logger.error('Failure connecting to redis.', err)
      process.exit(1)
    })

    redis.on('connect', () => {
      let promises = _.map(recordsToAdd, (record) => {
        const type = record[0]
          , args = record.slice(1)
          , domains = _.dropRightWhile(args, net.isIP)
          , ips = args.slice(domains.length)

        if(type == 'CNAME') {

          let domain = _.first(args)

          return _(_.rest(args))
            .map( (cname) => redis.set(`${type}:${cname}`, domain) )
            .flatten()
            .value()
        }
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
  })

program
  .command('remove <record...>')
  .alias('r')
  .description('remove dns entries')
  .action( (toRemove, options) => {
    _.defaults(options, conf)
    const redis = new Redis(options.redis)
      , recordsToRemove = parseRecords(toRemove)

    logger.info('Removing entries.', recordsToRemove)

    redis.on('error', (err) => {
      logger.error('Failure connecting to redis.', err)
      process.exit(1)
    })

    redis.on('connect', () => {
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
  })

program.on('--help', () => {
  console.log('  Examples:')
  console.log('')
  console.log('    $ simple-redis-dns server')
  console.log('    $ simple-redis-dns add A redis-dns.com 127.0.0.1 CNAME redis-dns.com www.redis-dns.com blah.redis-dns.com')
  console.log('')
  console.log('  Record:')
  console.log('    <type> <name...> <ip...>')
})

if(!process.argv.slice(2).length) {
  program.outputHelp()
}
program.parse(process.argv)
