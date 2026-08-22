'use strict';

var forEach = require('for-each');
var inspect = require('object-inspect');

module.exports = function (promiseTry, t) {
	if (typeof Promise !== 'function') {
		return t.skip('No global Promise detected');
	}

	t.test('non-function callback', function (st) {
		var cases = [undefined, true, false, [], {}];
		st.plan(2 * cases.length);

		var catchFn = function (x) {
			return function (e) {
				st.equal(e instanceof TypeError, true, inspect(x) + ': error is a TypeError');
				st.match(e.message, / not a function$/, inspect(x) + ': error message is correct');
			};
		};

		forEach(cases, function (x) {
			promiseTry(x).then(st.fail, catchFn(x));
		});
	});

	t.test('resolution', function (st) {
		st.plan(2);

		promiseTry(function () { return 42; }).then(function (x) {
			st.equal(x, 42, 'tried return of value is value');
		}, st.fail);

		promiseTry(function () { return Promise.resolve(42); }).then(function (x) {
			st.equal(x, 42, 'tried return of promise for value is value');
		}, st.fail);
	});

	t.test('args forwarding', function (st) {
		st.plan(2);

		var s1 = { one: true };
		var s2 = { two: true };

		promiseTry(
			function () {
				st.deepEqual(Array.prototype.slice.call(arguments), [s1]);
			},
			s1
		);

		promiseTry(
			function () {
				st.deepEqual(Array.prototype.slice.call(arguments), [s1, s2]);
			},
			s1,
			s2
		);

		st.end();
	});

	t.test('rejection', function (st) {
		st.plan(2);

		promiseTry(function () { throw Function; }).then(st.fail, function (e) {
			st.equal(e, Function, 'tried thrown value is rejected with value');
		});

		promiseTry(function () { return Promise.reject(42); }).then(st.fail, function (e) {
			st.equal(e, 42, 'tried rejected promise for value is rejected with value');
		});
	});

	t.test('same tick', function (st) {
		st.plan(1);

		promiseTry(function () {
			st.equal(arguments.length, 0, 'no arguments are passed');
		});

		st.end();
	});

	var Subclass = (function () {
		try {
			// eslint-disable-next-line no-new-func
			return Function('return class Subclass extends Promise {};')();
		} catch (e) { /**/ }

		return false;
	}());

	t.test('inheritance', { skip: !Subclass }, function (st) {
		st.test('preserves correct subclass', function (s2t) {
			var promise = promiseTry.call(Subclass, function () {});
			s2t.ok(promise instanceof Subclass, 'promise is instanceof Subclass');
			s2t.equal(promise.constructor, Subclass, 'promise.constructor is Subclass');

			s2t.end();
		});

		st.test('preserves correct subclass when rejected', function (s2t) {
			var promise = promiseTry.call(Subclass, function () {
				throw new Error('OMG');
			});
			s2t.ok(promise instanceof Subclass, 'promise is instanceof Subclass');
			s2t.equal(promise.constructor, Subclass, 'promise.constructor is Subclass');

			return promise.then(s2t.fail, s2t.ok);
		});

		st.test('preserves correct subclass when someone returns a thenable', function (s2t) {
			var promise = promiseTry.call(Subclass, function () {
				return Subclass.resolve(1);
			});
			s2t.ok(promise instanceof Subclass, 'promise is instanceof Subclass');
			s2t.equal(promise.constructor, Subclass, 'promise.constructor is Subclass');

			return promise;
		});
	});

	return t.comment('tests completed');
};
