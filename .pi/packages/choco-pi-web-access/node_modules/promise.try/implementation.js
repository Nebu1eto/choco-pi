'use strict';

var Call = require('es-abstract/2025/Call');
var NewPromiseCapability = require('es-abstract/2025/NewPromiseCapability');

var isObject = require('es-abstract/helpers/isObject');

var setFunctionName = require('set-function-name');
var $TypeError = require('es-errors/type');
var callBound = require('call-bind/callBound');

var $slice = callBound('Array.prototype.slice');

module.exports = setFunctionName(function try_(callbackfn) {
	/* eslint no-invalid-this: 0 */

	var C = this;
	if (!isObject(C)) {
		throw new $TypeError('receiver must be an object'); // step 2
	}

	var promiseCapability = NewPromiseCapability(C); // step 3

	var args = arguments.length > 1 ? $slice(arguments, 1) : [];

	try {
		var status = Call(callbackfn, undefined, args); // step 4

		Call(promiseCapability['[[Resolve]]'], undefined, [status]); // step 6.a
	} catch (e) {
		Call(promiseCapability['[[Reject]]'], undefined, [e]); // step 5.a
	}

	return promiseCapability['[[Promise]]'];
}, 'try', true);
