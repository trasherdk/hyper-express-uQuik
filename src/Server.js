const uWebSockets = require('uWebSockets.js')
const AjvJTD = require('ajv/dist/jtd')
const fastUri = require('fast-uri')
const Route = require('./Route')
const Router = require('./Router')
// eslint-disable-next-line no-unused-vars
const Stream = require('stream') // lgtm [js/unused-local-variable]
const Request = require('./Request')
const Response = require('./Response')

const { wrapObject } = require('./utils')

class Server extends Router {
  /**
     * @param {Object} options Server Options
     * @param {String} options.cert_file_name Path to SSL certificate file.
     * @param {String} options.key_file_name Path to SSL private key file to be used for SSL/TLS.
     * @param {String} options.passphrase Strong passphrase for SSL cryptographic purposes.
     * @param {String} options.dh_params_file_name Path to SSL Diffie-Hellman parameters file.
     * @param {Boolean} options.ssl_prefer_low_memory_usage Specifies uWebsockets to prefer lower memory usage while serving SSL
     * @param {Boolean} options.fast_buffers Buffer.allocUnsafe is used when set to true for faster performance.
     * @param {Boolean} options.fast_abort Determines whether  will abrubptly close bad requests. This can be much faster but the client does not receive an HTTP status code as it is a premature connection closure.
     * @param {Boolean} options.trust_proxy Specifies whether to trust incoming request data from intermediate proxy(s)
     * @param {Number} options.max_body_length Maximum body content length allowed in bytes. For Reference: 1kb = 1000 bytes and 1mb = 1000kb.
     * @param {Boolean} options.auto_close Whether to automatically close the server instance when the process exits. Default: true
     * @param {Object} options.ajv Ajv-JTD options
     */
  constructor (options = {}) {
    // Only accept object as a parameter type for options
    if (options == null || typeof options !== 'object') {
      throw new Error(
        'Server constructor only accepts an object type for the options parameter.'
      )
    }

    // Initialize extended Router instance
    super()

    this.options = {
      is_ssl: false,
      auto_close: true,
      fast_abort: false,
      trust_proxy: false,
      unsafe_buffers: false,
      max_body_length: 1153434002/* 250 * 1000 * 1000 */,
      ajv: {}
    }

    this._routes_locked = false
    this.handlers = {
      on_not_found: null,
      on_error: (request, response, error) => {
        // Throw on default if user has not bound an error handler
        response.status(500).send('Uncaught Exception Occured')
        throw error
      }
    }

    this._middlewares = {
      '/': [] // This will contain global middlewares
    }

    this._routes = {
      any: {},
      get: {},
      post: {},
      delete: {},
      head: {},
      options: {},
      patch: {},
      put: {},
      trace: {}
    }

    this.ajv = new AjvJTD({
      coerceTypes: 'array',
      useDefaults: true,
      removeAdditional: true,
      uriResolver: fastUri,
      // Explicitly set allErrors to `false`.
      // When set to `true`, a DoS attack is possible.
      allErrors: false,
      ...options.ajv
    })

    // Store options locally for access throughout processing
    wrapObject(this.options, options)

    // Create underlying uWebsockets App or SSLApp to power
    // eslint-disable-next-line camelcase
    const { cert_file_name, key_file_name } = options
    // eslint-disable-next-line camelcase
    this.options.is_ssl = cert_file_name && key_file_name // cert and key are required for SSL
    if (this.options.is_ssl) {
      this.uws_instance = uWebSockets.SSLApp(options)
    } else {
      this.uws_instance = uWebSockets.App(options)
    }
  }

  /**
     * @private
     * This method binds a cleanup handler which automatically closes this Server instance.
     */
  _bind_auto_close () {
    const reference = this;
    ['exit', 'SIGINT', 'SIGUSR1', 'SIGUSR2', 'SIGTERM'].forEach((type) =>
      process.once(type, () => reference.close())
    )
  }

  /**
     * Starts  webserver on specified port and host.
     *
     * @param {Number} port
     * @param {String=} host Optional. Default: 0.0.0.0
     * @returns {Promise} Promise
     */
  listen (port, host = '0.0.0.0') {
    return new Promise((resolve, reject) =>
      this.uws_instance.listen(host, port, (listenSocket) => {
        if (listenSocket) {
          // Store the listen socket for future closure & bind the auto close handler if enabled from constructor options
          this.listen_socket = listenSocket
          if (this.options.auto_close) this._bind_auto_close()
          resolve(listenSocket)
        } else {
          reject(new Error('No Socket Received From uWebsockets.js'))
        }
      })
    )
  }

  /**
     * Stops/Closes  webserver instance.
     *
     * @param {uWebSockets.us_listen_socket=} [listen_socket] Optional
     * @returns {Boolean}
     */
  close (listenSocket) {
    // Fall back to self listen socket if none provided by user
    const socket = listenSocket || this.listen_socket
    if (socket) {
      // Close the listen socket from uWebsockets and nullify the reference
      uWebSockets.us_listen_socket_close(socket)
      this.listen_socket = null
      return true
    }
    return false
  }

  /**
     * @typedef RouteErrorHandler
     * @type {function(Request, Response, Error):void}
     */

  /**
     * Sets a global error handler which will catch most uncaught errors across all routes/middlewares.
     *
     * @param {RouteErrorHandler} handler
     */
  set_error_handler (handler) {
    if (typeof handler !== 'function') throw new Error('handler must be a function')
    this.handlers.on_error = handler
  }

  /**
     * @typedef RouteHandler
     * @type {function(Request, Response):void}
     */

  /**
     * Sets a global not found handler which will handle all requests that are unhandled by any registered route.
     * Note! This handler must be registered after all routes and routers.
     *
     * @param {RouteHandler} handler
     */
  set_not_found_handler (handler) {
    if (typeof handler !== 'function') throw new Error('handler must be a function')

    // Store not_found handler and bind it as a catchall route
    if (this.handlers.on_not_found === null) {
      this.handlers.on_not_found = handler
      return setTimeout(
        (reference) => {
          reference.any('/*', (request, response) => reference.handlers.on_not_found(request, response))
          reference.routes_locked = true
        },
        0,
        this
      )
    }

    // Do not allow user to re-register not found handler
    throw new Error('A Not Found handler has already been registered.')
  }

  /**
     * Binds route to uWS server instance and begins handling incoming requests.
     *
     * @private
     * @param {Object} record { method, pattern, options, handler }
     */
  _create_route (record) {
    // Do not allow route creation once it is locked after a not found handler has been bound
    if (this._routes_locked === true) {
      throw new Error(`Routes/Routers must not be created or used after the set_not_found_handler() has been set due to uWebsockets.js's internal router not allowing for this to occur. [${record.method.toUpperCase()} ${record.pattern}]`)
    }

    // Do not allow duplicate routes for performance/stability reasons
    if (this._routes[record.method]?.[record.pattern]) {
      throw new Error(`Failed to create route as duplicate routes are not allowed. Ensure that you do not have any routers or routes that try to handle requests at the same pattern. [${record.method.toUpperCase()} ${record.pattern}]`
      )
    }

    // Process and combine middlewares for routes that support middlewares
    // Initialize route-specific middlewares if they do not exist
    if (!Array.isArray(record.options.middlewares)) record.options.middlewares = []

    // Parse middlewares that apply to this route based on execution pattern
    const middlewares = []
    Object.keys(this._middlewares).forEach((match) => {
      // Do not match with global middlewares as they are always executed separately
      if (match === '/') return

      // Store middleware if its execution pattern matches our route pattern
      if (record.pattern.startsWith(match)) this._middlewares[match].forEach((object) => middlewares.push(object))
    })

    // Map all user specified route specific middlewares with a priority of 2
    record.options.middlewares = record.options.middlewares.map((middleware) => ({
      priority: 2,
      middleware
    }))

    // Combine matched middlewares with route middlewares
    record.options.middlewares = middlewares.concat(record.options.middlewares)

    // Create a Route object to contain route information through handling process
    // Store route in routes object for structural tracking
    this._routes[record.method][record.pattern] = new Route({
      app: this,
      method: record.method,
      pattern: record.pattern,
      options: record.options,
      handler: record.handler
    })

    // Mark route as temporary if specified from options
    if (record.options._temporary === true) this._routes[record.method][record.pattern]._temporary = true

    // JSON Schema validators
    if (record.options.schema) {
      if (record.options.schema.request) this._routes[record.method][record.pattern].requestParser = this.ajv.compileParser(record.options.schema.request)
      if (record.options.schema.response) this._routes[record.method][record.pattern].responseSerializer = this.ajv.compileSerializer(record.options.schema.response)
    }

    // Bind uWS.method() route which passes incoming request/respone to our handler
    return this.uws_instance[record.method](record.pattern, (response, request) => this._handle_uws_request(this._routes[record.method][record.pattern], request, response))
  }

  /**
     * Binds middleware to server instance and distributes over all created routes.
     *
     * @private
     * @param {Object} record
     */
  _create_middleware (record) {
    // Initialize middlewares array for specified pattern
    if (this._middlewares[record.pattern] === undefined) this._middlewares[record.pattern] = []

    // Create a middleware object with an appropriate priority
    const object = {
      priority: record.pattern === '/' ? 0 : 1, // 0 priority are global middlewares
      middleware: record.middleware
    }

    // Store middleware object in its pattern branch
    this._middlewares[record.pattern].push(object)

    // Inject middleware into all routes that match its execution pattern if it is non global
    if (object.priority !== 0) {
      const match = record.pattern.endsWith('/') ? record.pattern.substr(0, record.pattern.length - 1) : record.pattern

      Object.keys(this._routes).forEach((method) => {
        // Match middleware pattern against all routes with this method
        const routes = this._routes[method]
        Object.keys(routes).forEach((pattern) => {
        // If route's pattern starts with middleware pattern, then use middleware
          if (pattern.startsWith(match)) routes[pattern].use(object)
        })
      })
    }
  }

  /* uWS -> Server Request/Response Handling Logic */

  /**
     * This method attempts to parse a valid content-length number value from header if present.
     *
     * @private
     * @param {Request} wrappedRequest
     * @returns {Number=}
     */
  _parse_content_length (wrappedRequest) {
    // Ensure we have some content-length value which specifies incoming bytes
    const contentLength = Number(wrappedRequest.headers['content-length'])
    return !isNaN(contentLength) ? contentLength : undefined
  }

  /**
     * This method is used to handle incoming uWebsockets response/request objects
     * by wrapping/translating them into  compatible request/response objects.
     *
     * @private
     * @param {Route} route
     * @param {Request} request
     * @param {Response} response
     */
  async _handle_uws_request (route, request, response) {
    // Request method
    const method = request.getMethod()

    // Wrap uWS.Request -> Request
    const wrappedRequest = new Request(
      request,
      response,
      route,
      method
    )

    // Wrap uWS.Response -> Response
    const wrappedResponse = new Response(wrappedRequest, response, route)

    // Determine the incoming content length if present
    wrappedRequest.contentLength = this._parse_content_length(wrappedRequest)

    // Checking if we need to get request body
    if (wrappedRequest.contentLength) {
      // Determine and compare against a maximum incoming content length from the route options with a fallback to the server options
      const maxBodyLength = route.options.max_body_length || route.app.options.max_body_length
      // Is bad request?
      const isBadRequest = method !== 'post' && method !== 'put' && method !== 'patch'
      if (wrappedRequest.contentLength > maxBodyLength || isBadRequest) {
        // Use fast abort scheme if specified in the server options
        if (this.options.fast_abort === true) return response.close()

        // For slow abort scheme, according to uWebsockets developer, we have to drain incoming data before aborting and closing request
        // Prematurely closing request with a 413 leads to an ECONNRESET in which we lose 413 status code from server
        return response.onData((_, isLast) => isLast && wrappedResponse.status(isBadRequest ? 400 : 413).send())
      }

      // Begin streaming the incoming body data
      wrappedRequest._start_streaming()
    } else {
      // Push an EOF chunk to signify the readable has already ended thus no more content is readable
      // wrappedRequest.push(null)
      wrappedRequest._stop_streaming()
    }

    // Chain incoming request/response through all global/local/route-specific middlewares
    return route.app._chain_middlewares(route, wrappedRequest, wrappedResponse)
  }

  /**
     * This method chains a request/response through all middlewares and then calls route handler in end.
     *
     * @private
     * @param {Route} route - Route Object
     * @param {Request} request - Request Object
     * @param {Response} response - Response Object
     * @param {Error} error - Error or Extended Error Object
     */
  _chain_middlewares (route, request, response, cursor = 0, error = null) {
    // Break chain if response has been aborted
    if (response.aborted) return

    // Trigger error handler if an error was provided by a middleware
    if (error) return response.throw(error)

    // Determine next callback based on if either global or route middlewares exist
    const globalMiddlewaresLength = this._middlewares['/'].length
    const hasGlobalMiddlewares = globalMiddlewaresLength !== 0
    const hasRouteMiddlewares = route.middlewares.length !== 0

    let next
    if (hasGlobalMiddlewares || hasRouteMiddlewares) {
      next = (err) => route.app._chain_middlewares(route, request, response, cursor + 1, err)

      // Execute global middlewares first as they take precedence over route specific middlewares
      if (hasGlobalMiddlewares) {
      // Determine current global middleware and execute
        if (this._middlewares['/'][cursor]) {
        // If middleware invocation returns a Promise, bind a then handler to trigger next iterator
          response._track_middleware_cursor(cursor)
          const output = this._middlewares['/'][cursor].middleware(request, response, next)
          if (typeof output === 'object' && typeof output.then === 'function') return output.then(next).catch(next)
        }
      }

      // Execute route specific middlewares if they exist
      if (hasRouteMiddlewares) {
      // Determine current route specific/method middleware and execute while accounting for global middlewares cursor offset
        const object = route.middlewares[cursor - globalMiddlewaresLength]
        if (object) {
        // If middleware invocation returns a Promise, bind a then handler to trigger next iterator
          response._track_middleware_cursor(cursor)
          const output = object.middleware(request, response, next)
          if (typeof output === 'object' && typeof output.then === 'function') return output.then(next).catch(next)
        }
      }
    }

    // Safely execute the user provided route handler
    try {
      const output = route.handler(request, response, response.upgrade_socket)
      if (typeof output === 'object' && typeof output.then === 'function') output.catch(next)
    } catch (error) {
      // If route handler throws an error, trigger error handler
      next(error)
    }
  }

  get routes () {
    return this._routes
  }

  get middlewares () {
    return this._middlewares
  }
}

module.exports = Server
