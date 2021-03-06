'use strict'

const FORMAT_HTTP_HEADERS = require('opentracing').FORMAT_HTTP_HEADERS
const log = require('../../log')
const tags = require('../../../ext/tags')
const types = require('../../../ext/types')
const kinds = require('../../../ext/kinds')

const HTTP = types.HTTP
const SERVER = kinds.SERVER
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const SPAN_KIND = tags.SPAN_KIND
const ERROR = tags.ERROR
const HTTP_METHOD = tags.HTTP_METHOD
const HTTP_URL = tags.HTTP_URL
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_ROUTE = tags.HTTP_ROUTE
const HTTP_HEADERS = tags.HTTP_HEADERS

const web = {
  // Ensure the configuration has the correct structure and defaults.
  normalizeConfig (config) {
    const headers = getHeadersToRecord(config)
    const validateStatus = getStatusValidator(config)
    const hooks = getHooks(config)

    return Object.assign({}, config, {
      headers,
      validateStatus,
      hooks
    })
  },

  // Start a span and activate a scope for a request.
  instrument (tracer, config, req, res, name, callback) {
    this.patch(req)

    const span = startSpan(tracer, config, req, res, name)

    if (config.service) {
      span.setTag(SERVICE_NAME, config.service)
    }

    callback && callback(span)

    wrapEnd(req)
    wrapEvents(req)

    return span
  },

  // Reactivate the request scope in case it was changed by a middleware.
  reactivate (req) {
    reactivate(req)
  },

  // Add a route segment that will be used for the resource name.
  enterRoute (req, path) {
    req._datadog.paths.push(path)
  },

  // Remove the current route segment.
  exitRoute (req) {
    req._datadog.paths.pop()
  },

  // Start a new middleware span and activate a new scope with the span.
  enterMiddleware (req, middleware, name) {
    if (!this.active(req)) return

    const tracer = req._datadog.tracer
    const childOf = this.active(req)
    const span = tracer.startSpan(name, { childOf })
    const scope = tracer.scopeManager().activate(span)

    span.addTags({
      [RESOURCE_NAME]: middleware.name || '<anonymous>'
    })

    req._datadog.middleware.push(scope)

    return span
  },

  // Close the active middleware scope and finish its span.
  exitMiddleware (req) {
    if (!this.active(req)) return

    const scope = req._datadog.middleware.pop()

    if (!scope) return

    const span = scope.span()

    span.finish()
    scope.close()
  },

  // Register a callback to run before res.end() is called.
  beforeEnd (req, callback) {
    req._datadog.beforeEnd.push(callback)
  },

  // Prepare the request for instrumentation.
  patch (req) {
    if (req._datadog) return

    Object.defineProperty(req, '_datadog', {
      value: {
        span: null,
        scope: null,
        paths: [],
        middleware: [],
        beforeEnd: []
      }
    })
  },

  // Return the request root span.
  root (req) {
    return req._datadog ? req._datadog.span : null
  },

  // Return the active span.
  active (req) {
    if (!req._datadog) return null
    if (req._datadog.middleware.length === 0) return req._datadog.span || null

    return req._datadog.middleware.slice(-1)[0].span()
  }
}

function startSpan (tracer, config, req, res, name) {
  req._datadog.config = config

  if (req._datadog.span) {
    req._datadog.span.context()._name = name
    return req._datadog.span
  }

  const childOf = tracer.extract(FORMAT_HTTP_HEADERS, req.headers)
  const span = tracer.startSpan(name, { childOf })
  const scope = tracer.scopeManager().activate(span)

  req._datadog.tracer = tracer
  req._datadog.span = span
  req._datadog.scope = scope
  req._datadog.res = res

  addRequestTags(req)

  return span
}

function finish (req, res) {
  if (req._datadog.finished) return

  addResponseTags(req)

  req._datadog.config.hooks.request(req._datadog.span, req, res)

  addResourceTag(req)

  req._datadog.span.finish()
  req._datadog.finished = true
}

function finishMiddleware (req, res) {
  if (req._datadog.finished) return

  let scope

  while ((scope = req._datadog.middleware.pop())) {
    scope.span().finish()
    scope.close()
  }
}

function wrapEnd (req) {
  const res = req._datadog.res
  const end = res.end

  if (end === req._datadog.end) return

  let _end = req._datadog.end = res.end = function () {
    req._datadog.beforeEnd.forEach(beforeEnd => beforeEnd())

    finishMiddleware(req, res)

    const returnValue = end.apply(this, arguments)

    finish(req, res)

    return returnValue
  }

  Object.defineProperty(res, 'end', {
    configurable: true,
    get () {
      return _end
    },
    set (value) {
      _end = value
      if (typeof value === 'function') {
        _end = function () {
          reactivate(req)
          return value.apply(this, arguments)
        }
      } else {
        _end = value
      }
    }
  })
}

function wrapEvents (req) {
  const res = req._datadog.res
  const on = res.on

  if (on === req._datadog.on) return

  req._datadog.on = res.on = function (eventName, listener) {
    if (typeof listener !== 'function') return on.apply(this, arguments)

    return on.call(this, eventName, function () {
      reactivate(req)
      return listener.apply(this, arguments)
    })
  }
}

function reactivate (req) {
  req._datadog.scope && req._datadog.scope.close()
  req._datadog.scope = req._datadog.tracer.scopeManager().activate(req._datadog.span)
}

function addRequestTags (req) {
  const protocol = req.connection.encrypted ? 'https' : 'http'
  const url = `${protocol}://${req.headers['host']}${req.url}`
  const span = req._datadog.span

  span.addTags({
    [HTTP_URL]: url,
    [HTTP_METHOD]: req.method,
    [SPAN_KIND]: SERVER,
    [SPAN_TYPE]: HTTP
  })

  addHeaders(req)
}

function addResponseTags (req) {
  const span = req._datadog.span
  const res = req._datadog.res

  if (req._datadog.paths.length > 0) {
    span.setTag(HTTP_ROUTE, req._datadog.paths.join(''))
  }

  span.addTags({
    [HTTP_STATUS_CODE]: res.statusCode
  })

  addStatusError(req)
}

function addResourceTag (req) {
  const span = req._datadog.span
  const tags = span.context()._tags

  if (tags['resource.name']) return

  const resource = [req.method]
    .concat(tags[HTTP_ROUTE])
    .filter(val => val)
    .join(' ')

  span.setTag(RESOURCE_NAME, resource)
}

function addHeaders (req) {
  const span = req._datadog.span

  req._datadog.config.headers.forEach(key => {
    const value = req.headers[key]

    if (value) {
      span.setTag(`${HTTP_HEADERS}.${key}`, value)
    }
  })
}

function addStatusError (req) {
  if (!req._datadog.config.validateStatus(req._datadog.res.statusCode)) {
    req._datadog.span.setTag(ERROR, true)
  }
}

function getHeadersToRecord (config) {
  if (Array.isArray(config.headers)) {
    try {
      return config.headers.map(key => key.toLowerCase())
    } catch (err) {
      log.error(err)
    }
  } else if (config.hasOwnProperty('headers')) {
    log.error('Expected `headers` to be an array of strings.')
  }
  return []
}

function getStatusValidator (config) {
  if (typeof config.validateStatus === 'function') {
    return config.validateStatus
  } else if (config.hasOwnProperty('validateStatus')) {
    log.error('Expected `validateStatus` to be a function.')
  }
  return code => code < 500
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = web
