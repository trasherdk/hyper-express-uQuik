/*!
 * negotiator
 * Copyright(c) 2012 Federico Romero
 * Copyright(c) 2012-2014 Isaac Z. Schlueter
 * Copyright(c) 2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

const preferredCharsets = require('./charset')
const preferredEncodings = require('./encoding')
const preferredLanguages = require('./anguage')
const preferredMediaTypes = require('./mediaType')

/**
 * Module exports.
 * @public
 */

module.exports = Negotiator
module.exports.Negotiator = Negotiator

/**
 * Create a Negotiator instance from a request.
 * @param {object} request
 * @public
 */

function Negotiator (request) {
  if (!(this instanceof Negotiator)) {
    return new Negotiator(request)
  }

  this.request = request
}

Negotiator.prototype.charset = function charset (available) {
  const set = this.charsets(available)
  return set && set[0]
}

Negotiator.prototype.charsets = function charsets (available) {
  return preferredCharsets(this.request.headers['accept-charset'], available)
}

Negotiator.prototype.encoding = function encoding (available) {
  const set = this.encodings(available)
  return set && set[0]
}

Negotiator.prototype.encodings = function encodings (available) {
  return preferredEncodings(this.request.headers['accept-encoding'], available)
}

Negotiator.prototype.language = function language (available) {
  const set = this.languages(available)
  return set && set[0]
}

Negotiator.prototype.languages = function languages (available) {
  return preferredLanguages(this.request.headers['accept-language'], available)
}

Negotiator.prototype.mediaType = function mediaType (available) {
  const set = this.mediaTypes(available)
  return set && set[0]
}

Negotiator.prototype.mediaTypes = function mediaTypes (available) {
  return preferredMediaTypes(this.request.headers.accept, available)
}

// Backwards compatibility
Negotiator.prototype.preferredCharset = Negotiator.prototype.charset
Negotiator.prototype.preferredCharsets = Negotiator.prototype.charsets
Negotiator.prototype.preferredEncoding = Negotiator.prototype.encoding
Negotiator.prototype.preferredEncodings = Negotiator.prototype.encodings
Negotiator.prototype.preferredLanguage = Negotiator.prototype.language
Negotiator.prototype.preferredLanguages = Negotiator.prototype.languages
Negotiator.prototype.preferredMediaType = Negotiator.prototype.mediaType
Negotiator.prototype.preferredMediaTypes = Negotiator.prototype.mediaTypes
