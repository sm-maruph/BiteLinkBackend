import test from 'node:test'
import assert from 'node:assert/strict'
import { createTableToken, verifyTableToken } from '../src/modules/guest/table-token.js'

const table={id:'9ac5cb3d-e484-4208-9017-b532b980ccf2',qr_token_hash:'d1f2b128d4434c50f6ec2ed84ba31d5b62db6821a851aed4d444db1b3e8d82fa'}

test('signed table tokens validate only for their table and secret version',()=>{
  const token=createTableToken(table)
  assert.equal(verifyTableToken(table,token),true)
  assert.equal(verifyTableToken({...table,id:'340ccd5a-0cf3-464c-982b-bf7a0cad732c'},token),false)
  assert.equal(verifyTableToken({...table,qr_token_hash:'rotated'},token),false)
  assert.equal(verifyTableToken(table,`${token}changed`),false)
})
