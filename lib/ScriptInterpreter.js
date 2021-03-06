var imports = require('soop').imports();
var config = imports.config || require('../config');
var log = imports.log || require('../util/log');
var util = imports.util || require('../util');
var Opcode = imports.Opcode || require('./Opcode');
var buffertools = imports.buffertools || require('buffertools');
var bignum = imports.bignum || require('./Bignum');
var Util = imports.Util || require('../util');
var Script = require('./Script');
var Key = require('./Key');

var SIGHASH_ALL = 1;
var SIGHASH_NONE = 2;
var SIGHASH_SINGLE = 3;
var SIGHASH_ANYONECANPAY = 80;

// Make opcodes available as pseudo-constants
var OP = {};
for (var i in Opcode.map) {
  var name = i.split('_').pop();
  OP["_"+name] = Opcode.map[i];
}

var intToBufferSM = Util.intToBufferSM
var bufferSMToInt = Util.bufferSMToInt;

function ScriptInterpreter(opts) {
  this.opts = opts || {};
  this.stack = [];
  this.disableUnsafeOpcodes = true;
};

ScriptInterpreter.prototype.evalScript = function evalScript(script, tx, inIndex, hashType, callback) {
  if ("function" !== typeof callback) {
    throw new Error("ScriptInterpreter.evalScript() requires a callback");
  }

  var pc = 0;
  var execStack = [];
  var altStack = [];
  var hashStart = 0;
  var opCount = 0;

  if (script.buffer.length > 10000) {
    callback(new Error("Oversized script (> 10k bytes)"));
    return this;
  }

  // Start execution by running the first step
  executeStep.call(this, callback);

  function executeStep(cb) {
    try {
      // Once all chunks have been processed, execution ends
      if (pc >= script.chunks.length) {
        // Execution stack must be empty at the end of the script
        if (execStack.length) {
          cb(new Error("Execution stack ended non-empty"));
          return;
        }

        // Execution successful (Note that we still have to check whether the
        // final stack contains a truthy value.)
        cb(null);
        return;
      }

      // The execution bit is true if there are no "false" values in the
      // execution stack. (A "false" value indicates that we're in the
      // inactive branch of an if statement.)
      var exec = !~execStack.indexOf(false);

      var opcode = script.chunks[pc++];

      if (opcode.length > 520) {
        throw new Error("Max push value size exceeded (>520)");
      }

      if (opcode > OP._16 && ++opCount > 201) {
        throw new Error("Opcode limit exceeded (>200)");
      }

      if (this.disableUnsafeOpcodes &&
        "number" === typeof opcode &&
        (opcode === OP._CAT ||
          opcode === OP._SUBSTR ||
          opcode === OP._LEFT ||
          opcode === OP._RIGHT ||
          opcode === OP._INVERT ||
          opcode === OP._AND ||
          opcode === OP._OR ||
          opcode === OP._XOR ||
          opcode === OP._2MUL ||
          opcode === OP._2DIV ||
          opcode === OP._MUL ||
          opcode === OP._DIV ||
          opcode === OP._MOD ||
          opcode === OP._LSHIFT ||
          opcode === OP._RSHIFT)) {
        throw new Error("Encountered a disabled opcode");
      }

      if (exec && Buffer.isBuffer(opcode)) {
        this.stack.push(opcode);
      } else if (exec || (OP._IF <= opcode && opcode <= OP._ENDIF))
        switch (opcode) {
          case OP._0:
            this.stack.push(new Buffer([]));
            break;

          case OP._1NEGATE:
          case OP._1:
          case OP._2:
          case OP._3:
          case OP._4:
          case OP._5:
          case OP._6:
          case OP._7:
          case OP._8:
          case OP._9:
          case OP._10:
          case OP._11:
          case OP._12:
          case OP._13:
          case OP._14:
          case OP._15:
          case OP._16:
            var opint = opcode - OP._1 + 1;
            var opbuf = intToBufferSM(opint);
            this.stack.push(opbuf);
            break;

          case OP._NOP:
          case OP._NOP1:
          case OP._NOP2:
          case OP._NOP3:
          case OP._NOP4:
          case OP._NOP5:
          case OP._NOP6:
          case OP._NOP7:
          case OP._NOP8:
          case OP._NOP9:
          case OP._NOP10:
            break;

          case OP._IF:
          case OP._NOTIF:
            // <expression> if [statements] [else [statements]] endif
            var value = false;
            if (exec) {
              value = castBool(this.stackPop());
              if (opcode === OP._NOTIF) {
                value = !value;
              }
            }
            execStack.push(value);
            break;

          case OP._ELSE:
            if (execStack.length < 1) {
              throw new Error("Unmatched OP_ELSE");
            }
            execStack[execStack.length - 1] = !execStack[execStack.length - 1];
            break;

          case OP._ENDIF:
            if (execStack.length < 1) {
              throw new Error("Unmatched OP_ENDIF");
            }
            execStack.pop();
            break;

          case OP._VERIFY:
            var value = castBool(this.stackTop());
            if (value) {
              this.stackPop();
            } else {
              throw new Error("OP_VERIFY negative");
            }
            break;

          case OP._RETURN:
            throw new Error("OP_RETURN");

          case OP._TOALTSTACK:
            altStack.push(this.stackPop());
            break;

          case OP._FROMALTSTACK:
            if (altStack.length < 1) {
              throw new Error("OP_FROMALTSTACK with alt stack empty");
            }
            this.stack.push(altStack.pop());
            break;

          case OP._2DROP:
            // (x1 x2 -- )
            this.stackPop();
            this.stackPop();
            break;

          case OP._2DUP:
            // (x1 x2 -- x1 x2 x1 x2)
            var v1 = this.stackTop(2);
            var v2 = this.stackTop(1);
            this.stack.push(v1);
            this.stack.push(v2);
            break;

          case OP._3DUP:
            // (x1 x2 -- x1 x2 x1 x2)
            var v1 = this.stackTop(3);
            var v2 = this.stackTop(2);
            var v3 = this.stackTop(1);
            this.stack.push(v1);
            this.stack.push(v2);
            this.stack.push(v3);
            break;

          case OP._2OVER:
            // (x1 x2 x3 x4 -- x1 x2 x3 x4 x1 x2)
            var v1 = this.stackTop(4);
            var v2 = this.stackTop(3);
            this.stack.push(v1);
            this.stack.push(v2);
            break;

          case OP._2ROT:
            // (x1 x2 x3 x4 x5 x6 -- x3 x4 x5 x6 x1 x2)
            var v1 = this.stackTop(6);
            var v2 = this.stackTop(5);
            this.stack.splice(this.stack.length - 6, 2);
            this.stack.push(v1);
            this.stack.push(v2);
            break;

          case OP._2SWAP:
            // (x1 x2 x3 x4 -- x3 x4 x1 x2)
            this.stackSwap(4, 2);
            this.stackSwap(3, 1);
            break;

          case OP._IFDUP:
            // (x - 0 | x x)
            var value = this.stackTop();
            if (castBool(value)) {
              this.stack.push(value);
            }
            break;

          case OP._DEPTH:
            // -- stacksize
            var value = bignum(this.stack.length);
            this.stack.push(intToBufferSM(value));
            break;

          case OP._DROP:
            // (x -- )
            this.stackPop();
            break;

          case OP._DUP:
            // (x -- x x)
            this.stack.push(this.stackTop());
            break;

          case OP._NIP:
            // (x1 x2 -- x2)
            if (this.stack.length < 2) {
              throw new Error("OP_NIP insufficient stack size");
            }
            this.stack.splice(this.stack.length - 2, 1);
            break;

          case OP._OVER:
            // (x1 x2 -- x1 x2 x1)
            this.stack.push(this.stackTop(2));
            break;

          case OP._PICK:
          case OP._ROLL:
            // (xn ... x2 x1 x0 n - xn ... x2 x1 x0 xn)
            // (xn ... x2 x1 x0 n - ... x2 x1 x0 xn)
            var n = castInt(this.stackPop());
            if (n < 0 || n >= this.stack.length) {
              throw new Error("OP_PICK/OP_ROLL insufficient stack size");
            }
            var value = this.stackTop(n + 1);
            if (opcode === OP._ROLL) {
              this.stack.splice(this.stack.length - n - 1, 1);
            }
            this.stack.push(value);
            break;

          case OP._ROT:
            // (x1 x2 x3 -- x2 x3 x1)
            //  x2 x1 x3  after first swap
            //  x2 x3 x1  after second swap
            this.stackSwap(3, 2);
            this.stackSwap(2, 1);
            break;

          case OP._SWAP:
            // (x1 x2 -- x2 x1)
            this.stackSwap(2, 1);
            break;

          case OP._TUCK:
            // (x1 x2 -- x2 x1 x2)
            if (this.stack.length < 2) {
              throw new Error("OP_TUCK insufficient stack size");
            }
            this.stack.splice(this.stack.length - 2, 0, this.stackTop());
            break;

          case OP._CAT:
            // (x1 x2 -- out)
            var v1 = this.stackTop(2);
            var v2 = this.stackTop(1);
            this.stackPop();
            this.stackPop();
            this.stack.push(Buffer.concat([v1, v2]));
            break;

          case OP._SUBSTR:
            // (in begin size -- out)
            var buf = this.stackTop(3);
            var start = castInt(this.stackTop(2));
            var len = castInt(this.stackTop(1));
            if (start < 0 || len < 0) {
              throw new Error("OP_SUBSTR start < 0 or len < 0");
            }
            if ((start + len) >= buf.length) {
              throw new Error("OP_SUBSTR range out of bounds");
            }
            this.stackPop();
            this.stackPop();
            this.stack[this.stack.length - 1] = buf.slice(start, start + len);
            break;

          case OP._LEFT:
          case OP._RIGHT:
            // (in size -- out)
            var buf = this.stackTop(2);
            var size = castInt(this.stackTop(1));
            if (size < 0) {
              throw new Error("OP_LEFT/OP_RIGHT size < 0");
            }
            if (size > buf.length) {
              size = buf.length;
            }
            this.stackPop();
            if (opcode === OP._LEFT) {
              this.stack[this.stack.length - 1] = buf.slice(0, size);
            } else {
              this.stack[this.stack.length - 1] = buf.slice(buf.length - size);
            }
            break;

          case OP._SIZE:
            // (in -- in size)
            var value = bignum(this.stackTop().length);
            this.stack.push(intToBufferSM(value));
            break;

          case OP._INVERT:
            // (in - out)
            var buf = this.stackTop();
            for (var i = 0, l = buf.length; i < l; i++) {
              buf[i] = ~buf[i];
            }
            break;

          case OP._AND:
          case OP._OR:
          case OP._XOR:
            // (x1 x2 - out)
            var v1 = this.stackTop(2);
            var v2 = this.stackTop(1);
            this.stackPop();
            this.stackPop();
            var out = new Buffer(Math.max(v1.length, v2.length));
            if (opcode === OP._AND) {
              for (var i = 0, l = out.length; i < l; i++) {
                out[i] = v1[i] & v2[i];
              }
            } else if (opcode === OP._OR) {
              for (var i = 0, l = out.length; i < l; i++) {
                out[i] = v1[i] | v2[i];
              }
            } else if (opcode === OP._XOR) {
              for (var i = 0, l = out.length; i < l; i++) {
                out[i] = v1[i] ^ v2[i];
              }
            }
            this.stack.push(out);
            break;

          case OP._EQUAL:
          case OP._EQUALVERIFY:
            //case OP._NOTEQUAL: // use OP_NUMNOTEQUAL
            // (x1 x2 - bool)
            var v1 = this.stackTop(2);
            var v2 = this.stackTop(1);

            var value = buffertools.compare(v1, v2) === 0;

            // OP_NOTEQUAL is disabled because it would be too easy to say
            // something like n != 1 and have some wiseguy pass in 1 with extra
            // zero bytes after it (numerically, 0x01 == 0x0001 == 0x000001)
            //if (opcode == OP._NOTEQUAL)
            //    fEqual = !fEqual;

            this.stackPop();
            this.stackPop();
            this.stack.push(new Buffer([value ? 1 : 0]));
            if (opcode === OP._EQUALVERIFY) {
              if (value) {
                this.stackPop();
              } else {
                throw new Error("OP_EQUALVERIFY negative");
              }
            }
            break;

          case OP._1ADD:
          case OP._1SUB:
          case OP._2MUL:
          case OP._2DIV:
          case OP._NEGATE:
          case OP._ABS:
          case OP._NOT:
          case OP._0NOTEQUAL:
            // (in -- out)
            var num = bufferSMToInt(this.stackTop());
            switch (opcode) {
              case OP._1ADD:
                num = num.add(bignum(1));
                break;
              case OP._1SUB:
                num = num.sub(bignum(1));
                break;
              case OP._2MUL:
                num = num.mul(bignum(2));
                break;
              case OP._2DIV:
                num = num.div(bignum(2));
                break;
              case OP._NEGATE:
                num = num.neg();
                break;
              case OP._ABS:
                num = num.abs();
                break;
              case OP._NOT:
                num = bignum(num.cmp(0) == 0 ? 1 : 0);
                break;
              case OP._0NOTEQUAL:
                num = bignum(num.cmp(0) == 0 ? 0 : 1);
                break;
            }
            this.stack[this.stack.length - 1] = intToBufferSM(num);
            break;

          case OP._ADD:
          case OP._SUB:
          case OP._MUL:
          case OP._DIV:
          case OP._MOD:
          case OP._LSHIFT:
          case OP._RSHIFT:
          case OP._BOOLAND:
          case OP._BOOLOR:
          case OP._NUMEQUAL:
          case OP._NUMEQUALVERIFY:
          case OP._NUMNOTEQUAL:
          case OP._LESSTHAN:
          case OP._GREATERTHAN:
          case OP._LESSTHANOREQUAL:
          case OP._GREATERTHANOREQUAL:
          case OP._MIN:
          case OP._MAX:
            // (x1 x2 -- out)
            var v1 = bufferSMToInt(this.stackTop(2));
            var v2 = bufferSMToInt(this.stackTop(1));
            var num;
            switch (opcode) {
              case OP._ADD:
                num = v1.add(v2);
                break;
              case OP._SUB:
                num = v1.sub(v2);
                break;
              case OP._MUL:
                num = v1.mul(v2);
                break;
              case OP._DIV:
                num = v1.div(v2);
                break;
              case OP._MOD:
                num = v1.mod(v2);
                break;

              case OP._LSHIFT:
                if (v2.cmp(0) < 0 || v2.cmp(2048) > 0) {
                  throw new Error("OP_LSHIFT parameter out of bounds");
                }
                num = v1.shiftLeft(v2);
                break;

              case OP._RSHIFT:
                if (v2.cmp(0) < 0 || v2.cmp(2048) > 0) {
                  throw new Error("OP_RSHIFT parameter out of bounds");
                }
                num = v1.shiftRight(v2);
                break;

              case OP._BOOLAND:
                num = bignum((v1.cmp(0) != 0 && v2.cmp(0) != 0) ? 1 : 0);
                break;

              case OP._BOOLOR:
                num = bignum((v1.cmp(0) != 0 || v2.cmp(0) != 0) ? 1 : 0);
                break;

              case OP._NUMEQUAL:
              case OP._NUMEQUALVERIFY:
                num = bignum(v1.cmp(v2) == 0 ? 1 : 0);
                break;

              case OP._NUMNOTEQUAL:
                ;
                num = bignum(v1.cmp(v2) != 0 ? 1 : 0);
                break;

              case OP._LESSTHAN:
                num = bignum(v1.lt(v2) ? 1 : 0);
                break;

              case OP._GREATERTHAN:
                num = bignum(v1.gt(v2) ? 1 : 0);
                break;

              case OP._LESSTHANOREQUAL:
                num = bignum(v1.gt(v2) ? 0 : 1);
                break;

              case OP._GREATERTHANOREQUAL:
                num = bignum(v1.lt(v2) ? 0 : 1);
                break;

              case OP._MIN:
                num = (v1.lt(v2) ? v1 : v2);
                break;
              case OP._MAX:
                num = (v1.gt(v2) ? v1 : v2);
                break;
            }
            this.stackPop();
            this.stackPop();
            this.stack.push(intToBufferSM(num));

            if (opcode === OP._NUMEQUALVERIFY) {
              if (castBool(this.stackTop())) {
                this.stackPop();
              } else {
                throw new Error("OP_NUMEQUALVERIFY negative");
              }
            }
            break;

          case OP._WITHIN:
            // (x min max -- out)
            var v1 = bufferSMToInt(this.stackTop(3));
            var v2 = bufferSMToInt(this.stackTop(2));
            var v3 = bufferSMToInt(this.stackTop(1));
            this.stackPop();
            this.stackPop();
            this.stackPop();
            var value = v1.cmp(v2) >= 0 && v1.cmp(v3) < 0;
            this.stack.push(intToBufferSM(value ? 1 : 0));
            break;

          case OP._RIPEMD160:
          case OP._SHA1:
          case OP._SHA256:
          case OP._HASH160:
          case OP._HASH256:
            // (in -- hash)
            var value = this.stackPop();
            var hash;
            if (opcode === OP._RIPEMD160) {
              hash = Util.ripe160(value);
            } else if (opcode === OP._SHA1) {
              hash = Util.sha1(value);
            } else if (opcode === OP._SHA256) {
              hash = Util.sha256(value);
            } else if (opcode === OP._HASH160) {
              hash = Util.sha256ripe160(value);
            } else if (opcode === OP._HASH256) {
              hash = Util.twoSha256(value);
            }
            this.stack.push(hash);
            break;

          case OP._CODESEPARATOR:
            // Hash starts after the code separator
            hashStart = pc;
            break;

          case OP._CHECKSIG:
          case OP._CHECKSIGVERIFY:
            // (sig pubkey -- bool)
            var sig = this.stackTop(2);
            var pubkey = this.stackTop(1);

            // Get the part of this script since the last OP_CODESEPARATOR
            var scriptChunks = script.chunks.slice(hashStart);

            // Convert to binary
            var scriptCode = Script.fromChunks(scriptChunks);

            // Remove signature if present (a signature can't sign itself)
            scriptCode.findAndDelete(sig);

            // check canonical signature
            this.isCanonicalSignature(new Buffer(sig));

            // Verify signature
            checkSig(sig, pubkey, scriptCode, tx, inIndex, hashType, function(e, result) {
              var success;

              if (e) {
                // We intentionally ignore errors during signature verification and
                // treat these cases as an invalid signature.
                success = false;
              } else {
                success = result;
              }

              // Update stack
              this.stackPop();
              this.stackPop();
              this.stack.push(new Buffer([success ? 1 : 0]));
              if (opcode === OP._CHECKSIGVERIFY) {
                if (success) {
                  this.stackPop();
                } else {
                  throw new Error("OP_CHECKSIGVERIFY negative");
                }
              }

              // Run next step
              executeStep.call(this, cb);
            }.bind(this));

            // Note that for asynchronous opcodes we have to return here to prevent
            // the next opcode from being executed.
            return;

          case OP._CHECKMULTISIG:
          case OP._CHECKMULTISIGVERIFY:
            // ([sig ...] num_of_signatures [pubkey ...] num_of_pubkeys -- bool)
            var keysCount = castInt(this.stackPop());
            if (keysCount < 0 || keysCount > 20) {
              throw new Error("OP_CHECKMULTISIG keysCount out of bounds");
            }
            opCount += keysCount;
            if (opCount > 201) {
              throw new Error("Opcode limit exceeded (>200)");
            }
            var keys = [];
            for (var i = 0, l = keysCount; i < l; i++) {
              var pubkey = this.stackPop()
              keys.push(pubkey);
            }

            var sigsCount = castInt(this.stackPop());
            if (sigsCount < 0 || sigsCount > keysCount) {
              throw new Error("OP_CHECKMULTISIG sigsCount out of bounds");
            }
            var sigs = [];
            for (var i = 0, l = sigsCount; i < l; i++) {
              sigs.push(this.stackPop());
            }

            // The original client has a bug where it pops an extra element off the
            // stack. It can't be fixed without causing a chain split and we need to
            // imitate this behavior as well.
            this.stackPop();

            // Get the part of this script since the last OP_CODESEPARATOR
            var scriptChunks = script.chunks.slice(hashStart);

            // Convert to binary
            var scriptCode = Script.fromChunks(scriptChunks);

            var that = this;
            sigs.forEach(function(sig) {
              // check each signature is canonical
              that.isCanonicalSignature(new Buffer(sig));
              // Drop the signatures for the subscript, since a signature can't sign itself
              scriptCode.findAndDelete(sig);
            });

            var success = true,
              isig = 0,
              ikey = 0;

            function checkMultiSigStep() {
              if (success && sigsCount > 0) {
                var sig = sigs[isig];
                var pubkey = keys[ikey];

                checkSig(sig, pubkey, scriptCode, tx, inIndex, hashType, function(e, result) {
                  if (!e && result) {
                    isig++;
                    sigsCount--;
                  } else {
                    ikey++;
                    keysCount--;

                    // If there are more signatures than keys left, then too many
                    // signatures have failed
                    if (sigsCount > keysCount) {
                      success = false;
                    }
                  }

                  checkMultiSigStep.call(this);
                }.bind(this));
              } else {
                this.stack.push(new Buffer([success ? 1 : 0]));
                if (opcode === OP._CHECKMULTISIGVERIFY) {
                  if (success) {
                    this.stackPop();
                  } else {
                    throw new Error("OP_CHECKMULTISIGVERIFY negative");
                  }
                }

                // Run next step
                executeStep.call(this, cb);
              }
            };
            checkMultiSigStep.call(this);

            // Note that for asynchronous opcodes we have to return here to prevent
            // the next opcode from being executed.
            return;

          default:
            throw new Error("Unknown opcode encountered");
        }

      // Size limits
      if ((this.stack.length + altStack.length) > 1000) {
        throw new Error("Maximum stack size exceeded");
      }

      // Run next step
      if (false && pc % 100) {
        // V8 allows for much deeper stacks than Bitcoin's scripting language,
        // but just to be safe, we'll reset the stack every 100 steps
        process.nextTick(executeStep.bind(this, cb));
      } else {
        executeStep.call(this, cb);
      }
    } catch (e) {
      cb(e);
    }
  }
};

ScriptInterpreter.prototype.evalTwo =
  function evalTwo(scriptSig, scriptPubkey, tx, n, hashType, callback) {
    var self = this;

    self.evalScript(scriptSig, tx, n, hashType, function(e) {
      if (e) {
        callback(e)
        return;
      }

      self.evalScript(scriptPubkey, tx, n, hashType, callback);
    });
};

/**
 * Get the top element of the stack.
 *
 * Using the offset parameter this function can also access lower elements
 * from the stack.
 */
ScriptInterpreter.prototype.stackTop = function stackTop(offset) {
  offset = +offset || 1;
  if (offset < 1) offset = 1;

  if (offset > this.stack.length) {
    throw new Error('ScriptInterpreter.stackTop(): Stack underrun');
  }

  return this.stack[this.stack.length - offset];
};

ScriptInterpreter.prototype.stackBack = function stackBack() {
  return this.stack[this.stack.length - 1];
};

/**
 * Pop the top element off the stack and return it.
 */
ScriptInterpreter.prototype.stackPop = function stackPop() {
  if (this.stack.length < 1) {
    throw new Error('ScriptInterpreter.stackTop(): Stack underrun');
  }

  return this.stack.pop();
};

ScriptInterpreter.prototype.stackSwap = function stackSwap(a, b) {
  if (this.stack.length < a || this.stack.length < b) {
    throw new Error('ScriptInterpreter.stackTop(): Stack underrun');
  }

  var s = this.stack,
    l = s.length;

  var tmp = s[l - a];
  s[l - a] = s[l - b];
  s[l - b] = tmp;
};

/**
 * Returns a version of the stack with only primitive types.
 *
 * The return value is an array. Any single byte buffer is converted to an
 * integer. Any longer Buffer is converted to a hex string.
 */
ScriptInterpreter.prototype.getPrimitiveStack = function getPrimitiveStack() {
  return this.stack.map(function(chunk) {
    if (chunk.length > 2) {
      return buffertools.toHex(chunk.slice(0));
    }
    var num = bufferSMToInt(chunk);
    if (num.cmp(-128) >= 0 && num.cmp(127) <= 0) {
      return num.toNumber();
    } else {
      return buffertools.toHex(chunk.slice(0));
    }
  });
};

var castBool = ScriptInterpreter.castBool = function castBool(v) {
  for (var i = 0, l = v.length; i < l; i++) {
    if (v[i] != 0) {
      // Negative zero is still zero
      if (i == (l - 1) && v[i] == 0x80) {
        return false;
      }
      return true;
    }
  }
  return false;
};
var castInt = ScriptInterpreter.castInt = function castInt(v) {
  return bufferSMToInt(v).toNumber();
};

ScriptInterpreter.prototype.getResult = function getResult() {
  if (this.stack.length === 0) {
    throw new Error("Empty stack after script evaluation");
  }

  return castBool(this.stack[this.stack.length - 1]);
};

// WARN: Use ScriptInterpreter.verifyFull instead
ScriptInterpreter.verify =
  function verify(scriptSig, scriptPubKey, tx, n, hashType, callback) {
    if ("function" !== typeof callback) {
      throw new Error("ScriptInterpreter.verify() requires a callback");
    }

    // Create execution environment
    var si = new ScriptInterpreter();

    // Evaluate scripts
    si.evalTwo(scriptSig, scriptPubKey, tx, n, hashType, function(err) {
      if (err) {
        callback(err);
        return;
      }

      // Cast result to bool
      var result = si.getResult();

      callback(null, result);
    });

    return si;
};

ScriptInterpreter.prototype.verifyStep4 = function(callback, siCopy) {
  // 4th step, check P2SH subscript evaluated to true
  if (siCopy.stack.length == 0) {
    callback(null, false);
    return;
  }

  callback(null, castBool(siCopy.stackBack()));
}

ScriptInterpreter.prototype.verifyStep3 = function(scriptSig,
  scriptPubKey, tx, nIn, hashType, callback, siCopy) {

  // 3rd step, check result (stack should contain true)

  // if stack is empty, script considered invalid
  if (this.stack.length === 0) {
    callback(null, false);
    return;
  }

  // if top of stack contains false, script evaluated to false
  if (castBool(this.stackBack()) == false) {
    callback(null, false);
    return;
  }

  // if not P2SH, script evaluated to true
  if (!this.opts.verifyP2SH || !scriptPubKey.isP2SH()) {
    callback(null, true);
    return;
  }

  // if P2SH, scriptSig should be push-only
  if (!scriptSig.isPushOnly()) {
    callback(null, false);
    return;
  }

  // P2SH script should exist
  if (siCopy.length === 0) {
    throw new Error('siCopy should have length != 0');
  }

  var subscript = new Script(siCopy.stackPop());
  var that = this;
  // evaluate the P2SH subscript
  siCopy.evalScript(subscript, tx, nIn, hashType, function(err) {
    if (err) return callback(err);
    that.verifyStep4(callback, siCopy);
  });
};

ScriptInterpreter.prototype.verifyStep2 = function(scriptSig, scriptPubKey,
  tx, nIn, hashType, callback, siCopy) {
  var siCopy;
  if (this.opts.verifyP2SH) {
    siCopy = new ScriptInterpreter(this.opts);
    this.stack.forEach(function(item) {
      siCopy.stack.push(item);
    });
  }

  var that = this;
  // 2nd step, evaluate scriptPubKey
  this.evalScript(scriptPubKey, tx, nIn, hashType, function(err) {
    if (err) return callback(err);
    that.verifyStep3(scriptSig, scriptPubKey, tx, nIn,
      hashType, callback, siCopy);
  });
};

ScriptInterpreter.prototype.verifyFull = function(scriptSig, scriptPubKey,
  tx, nIn, hashType, callback) {
  var that = this;

  // 1st step, evaluate scriptSig
  this.evalScript(scriptSig, tx, nIn, hashType, function(err) {
    if (err) return callback(err);
    that.verifyStep2(scriptSig, scriptPubKey, tx, nIn,
      hashType, callback);
  });
};

ScriptInterpreter.verifyFull =
  function verifyFull(scriptSig, scriptPubKey, tx, nIn, hashType,
    opts, callback) {
    var si = new ScriptInterpreter(opts);
    si.verifyFull(scriptSig, scriptPubKey,
      tx, nIn, hashType, callback);
};


var checkSig = ScriptInterpreter.checkSig =
  function(sig, pubkey, scriptCode, tx, n, hashType, callback) {
    // https://en.bitcoin.it/wiki/OP_CHECKSIG#How_it_works
    if (!sig.length) {
      callback(null, false);
      return;
    }

    // If the hash-type value is 0, then it is replaced by the last_byte of the signature.
    if (hashType === 0) {
      hashType = sig[sig.length - 1];
    } else if (hashType != sig[sig.length - 1]) {
      callback(null, false);
      return;
    }

    // Then the last byte of the signature is always deleted. (hashType removed)
    sig = sig.slice(0, sig.length - 1);

    // Signature verification requires a special hash procedure
    var hash = tx.hashForSignature(scriptCode, n, hashType);

    // Verify signature
    var key = new Key();
    if (pubkey.length === 0) pubkey = new Buffer('00', 'hex');
    key.public = pubkey;

    key.verifySignature(hash, sig, callback);
};

ScriptInterpreter.prototype.isCanonicalSignature = function(sig) {
  // See https://bitcointalk.org/index.php?topic=8392.msg127623#msg127623
  // A canonical signature exists of: <30> <total len> <02> <len R> <R> <02> <len S> <S> <hashtype>
  // Where R and S are not negative (their first byte has its highest bit not set), and not
  // excessively padded (do not start with a 0 byte, unless an otherwise negative number follows,
  // in which case a single 0 byte is necessary and even required).

  if (!Buffer.isBuffer(sig))
    throw new Error("arg should be a Buffer");

  // TODO: change to opts.verifyStrictEnc to make the default
  // behavior not verify, as in bitcoin core
  if (this.opts.dontVerifyStrictEnc) return true;

  var l = sig.length;
  if (l < 9) throw new Error("Non-canonical signature: too short");
  if (l > 73) throw new Error("Non-canonical signature: too long");

  var nHashType = sig[l - 1] & (~(SIGHASH_ANYONECANPAY));
  if (nHashType < SIGHASH_ALL || nHashType > SIGHASH_SINGLE)
    throw new Error("Non-canonical signature: unknown hashtype byte");

  if (sig[0] !== 0x30)
    throw new Error("Non-canonical signature: wrong type");
  if (sig[1] !== l - 3)
    throw new Error("Non-canonical signature: wrong length marker");

  var nLenR = sig[3];
  if (5 + nLenR >= l)
    throw new Error("Non-canonical signature: S length misplaced");

  var nLenS = sig[5 + nLenR];
  if ((nLenR + nLenS + 7) !== l)
    throw new Error("Non-canonical signature: R+S length mismatch");

  var rPos = 4;
  var R = new Buffer(nLenR);
  sig.copy(R, 0, rPos, rPos + nLenR);
  if (sig[rPos - 2] !== 0x02)
    throw new Error("Non-canonical signature: R value type mismatch");
  if (nLenR == 0)
    throw new Error("Non-canonical signature: R length is zero");
  if (R[0] & 0x80)
    throw new Error("Non-canonical signature: R value negative");
  if (nLenR > 1 && (R[0] == 0x00) && !(R[1] & 0x80))
    throw new Error("Non-canonical signature: R value excessively padded");

  var sPos = 6 + nLenR;
  var S = new Buffer(nLenS);
  sig.copy(S, 0, sPos, sPos + nLenS);
  if (sig[sPos - 2] != 0x02)
    throw new Error("Non-canonical signature: S value type mismatch");
  if (nLenS == 0)
    throw new Error("Non-canonical signature: S length is zero");
  if (S[0] & 0x80)
    throw new Error("Non-canonical signature: S value negative");
  if (nLenS > 1 && (S[0] == 0x00) && !(S[1] & 0x80))
    throw new Error("Non-canonical signature: S value excessively padded");

  if (this.opts.verifyEvenS) {
    if (S[nLenS - 1] & 1)
      throw new Error("Non-canonical signature: S value odd");
  }
  return true;
};

module.exports = require('soop')(ScriptInterpreter);
