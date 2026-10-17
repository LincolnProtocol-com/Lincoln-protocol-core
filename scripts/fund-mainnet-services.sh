#!/bin/bash
# Explicit local funding only. Default is an offline plan. No automatic resend.
set -euo pipefail
set +x
umask 077
LINCOLN_FUND_TEMP=
LINCOLN_FUND_SEND=0
for LINCOLN_FUND_ARG in "$@"; do
  if test "$LINCOLN_FUND_ARG" = --send; then LINCOLN_FUND_SEND=1; fi
done
lincoln_fund_cleanup() {
  if test -n "$LINCOLN_FUND_TEMP"; then rm -rf -- "$LINCOLN_FUND_TEMP"; fi
}
trap lincoln_fund_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if test "$LINCOLN_FUND_SEND" = 1; then
  test -t 0 && test -t 2 || { echo 'FUNDING_LOCAL_TTY_REQUIRED' >&2; exit 1; }
  LINCOLN_FUND_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/lincoln-mainnet-funding.XXXXXXXX")
  chmod 0700 "$LINCOLN_FUND_TEMP"
fi
python3 - "$LINCOLN_FUND_TEMP" "$@" <<'PY'
import argparse
import fcntl
import getpass
import itertools
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import warnings

RPC = 'https://rpc.mainnet.chain.robinhood.com/'
CHAIN = 4663
GENESIS = '0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c'
ACCOUNT = 'lincoln-deployer'
DEPLOYER = '0x555998Ba2B2723C97d91FB20Da0ddb896749797e'
ASP = '0xce6770154D793dF78FbfA0D3615B2946366E6612'
AMOUNTS = {'relay': '7000000000000000', 'asp': '3000000000000000'}
GAS = 21000
PRICE = 100000000
RESERVE = 3000000000000000
SCHEMA = 'lincoln-mainnet-service-funding/v1'
STATE = Path.home() / '.local/state/lincoln/mainnet-service-funding-4663' / DEPLOYER.lower()
COUNTER = itertools.count(1)


def need(ok, code):
    if not ok:
        raise RuntimeError(code)


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('FUNDING_RPC_REDIRECT_REJECTED')


OPENER = urllib.request.build_opener(NoRedirect())


def rpc(method, params):
    number = next(COUNTER)
    body = json.dumps({'jsonrpc': '2.0', 'id': number, 'method': method, 'params': params}).encode()
    request = urllib.request.Request(RPC, data=body,
                                    headers={'Content-Type': 'application/json', 'User-Agent': 'Lincoln-Mainnet-Funding/1.0'})
    try:
        with OPENER.open(request, timeout=30) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        need(len(data) <= 8 * 1024 * 1024, 'FUNDING_RPC_RESPONSE_TOO_LARGE')
        result = json.loads(data)
        need(result.get('jsonrpc') == '2.0' and result.get('id') == number
             and 'result' in result and 'error' not in result, 'FUNDING_RPC_REJECTED')
        return result['result']
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('FUNDING_RPC_UNAVAILABLE') from None


def quantity(value):
    need(isinstance(value, str) and re.fullmatch(r'0x[0-9a-fA-F]+', value), 'FUNDING_RPC_QUANTITY_INVALID')
    return int(value, 16)


def address(value):
    need(isinstance(value, str) and re.fullmatch(r'0x[0-9a-fA-F]{40}', value)
         and int(value[2:], 16) != 0, 'FUNDING_ADDRESS_INVALID')
    return value.lower()


def same(first, second):
    return isinstance(first, str) and isinstance(second, str) and first.lower() == second.lower()


def timestamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def private_directory(directory):
    home = Path.home()
    need(home.resolve() == home, 'FUNDING_HOME_CANONICAL_REQUIRED')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = home
    for component in directory.relative_to(home).parts:
        parent = parent / component
        info = parent.lstat()
        need(parent.resolve() == parent and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
             and stat.S_IMODE(info.st_mode) & 0o022 == 0, 'FUNDING_UNSAFE_STATE_PARENT')
    info = directory.lstat()
    need(directory.resolve() == directory and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
         and stat.S_IMODE(info.st_mode) == 0o700, 'FUNDING_PRIVATE_DIRECTORY_REQUIRED')


def private_json(filename):
    need(filename.resolve() == filename, 'FUNDING_JOURNAL_CANONICAL_REQUIRED')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as stream:
        info = os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
             and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 1024 * 1024,
             'FUNDING_UNSAFE_JOURNAL')
        return json.load(stream)


def save(journal):
    filename = STATE / ('.journal-' + secrets.token_hex(12))
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(journal, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(filename, STATE / 'journal.json')
        parent = os.open(STATE, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if filename.exists():
            filename.unlink()


def identity(relay):
    return {'chainId': CHAIN, 'genesisHash': GENESIS, 'account': ACCOUNT, 'deployer': DEPLOYER.lower(),
            'targets': {'relay': relay, 'asp': ASP.lower()}, 'amountsWei': AMOUNTS,
            'gasLimit': str(GAS), 'gasPriceWei': str(PRICE), 'reserveWei': str(RESERVE)}


def check_chain():
    need(quantity(rpc('eth_chainId', [])) == CHAIN, 'FUNDING_WRONG_CHAIN')
    need(same(rpc('eth_getBlockByNumber', ['0x0', False]).get('hash'), GENESIS), 'FUNDING_WRONG_GENESIS')


def verify_transaction(entry, transaction_hash):
    transaction = rpc('eth_getTransactionByHash', [transaction_hash])
    need(transaction is not None, 'FUNDING_KNOWN_HASH_NOT_FOUND_NO_RESEND')
    need(same(transaction.get('hash'), transaction_hash) and same(transaction.get('from'), DEPLOYER)
         and same(transaction.get('to'), entry['to']) and quantity(transaction.get('nonce')) == int(entry['nonce'])
         and quantity(transaction.get('value')) == int(entry['valueWei'])
         and quantity(transaction.get('gas')) == GAS and quantity(transaction.get('gasPrice')) == PRICE
         and transaction.get('input') == '0x' and quantity(transaction.get('type', '0x0')) == 0,
         'FUNDING_TRANSACTION_INTENT_MISMATCH')
    # Require legacy EIP-155 replay protection even on nodes omitting chainId.
    need(quantity(transaction.get('v')) in (CHAIN * 2 + 35, CHAIN * 2 + 36), 'FUNDING_TRANSACTION_CHAIN_MISMATCH')
    if transaction.get('chainId') is not None:
        need(quantity(transaction['chainId']) == CHAIN, 'FUNDING_TRANSACTION_CHAIN_MISMATCH')
    return transaction


def reconcile(journal, entry, wait=False):
    transaction_hash = entry.get('transactionHash')
    need(isinstance(transaction_hash, str) and re.fullmatch(r'0x[0-9a-fA-F]{64}', transaction_hash),
         'FUNDING_UNKNOWN_BROADCAST_MANUAL_HASH_REQUIRED')
    deadline = time.monotonic() + (90 if wait else 0)
    while True:
        receipt = rpc('eth_getTransactionReceipt', [transaction_hash])
        if receipt is not None:
            transaction = verify_transaction(entry, transaction_hash)
            number = quantity(receipt.get('blockNumber'))
            block = rpc('eth_getBlockByNumber', [hex(number), False])
            transaction_index = quantity(receipt.get('transactionIndex'))
            need(block is not None and quantity(block.get('number')) == number
                 and isinstance(block.get('hash'), str) and re.fullmatch(r'0x[0-9a-fA-F]{64}', block['hash'])
                 and same(receipt.get('transactionHash'), transaction_hash)
                 and same(receipt.get('from'), DEPLOYER) and same(receipt.get('to'), entry['to'])
                 and receipt.get('contractAddress') is None and quantity(receipt.get('type', '0x0')) == 0
                 and same(receipt.get('blockHash'), block.get('hash'))
                 and same(transaction.get('blockHash'), block.get('hash'))
                 and quantity(transaction.get('blockNumber')) == number
                 and quantity(transaction.get('transactionIndex')) == transaction_index
                 and isinstance(block.get('transactions'), list)
                 and transaction_index < len(block['transactions'])
                 and same(block['transactions'][transaction_index], transaction_hash),
                 'FUNDING_RECEIPT_NOT_CANONICAL')
            used = quantity(receipt.get('gasUsed'))
            price = quantity(receipt.get('effectiveGasPrice'))
            need(0 < used <= GAS and price == PRICE, 'FUNDING_RECEIPT_FEE_MISMATCH')
            status = quantity(receipt.get('status'))
            need(status in (0, 1), 'FUNDING_RECEIPT_STATUS_INVALID')
            need(entry['status'] != 'confirmed' or status == 1,
                 'FUNDING_CONFIRMED_RECEIPT_CHANGED')
            if status == 0:
                entry.update({'status': 'reverted', 'feeWei': str(used * price), 'blockNumber': str(number)})
                save(journal)
                raise RuntimeError('FUNDING_TRANSFER_REVERTED_NO_RESEND')
            if quantity(rpc('eth_blockNumber', [])) >= number + 1:
                entry.update({'status': 'confirmed', 'feeWei': str(used * price), 'blockNumber': str(number),
                              'blockHash': block['hash'], 'confirmedAtUTC': timestamp()})
                save(journal)
                emit({'role': entry['role'], 'transactionHash': transaction_hash,
                      'receipt': {'status': 1, 'blockNumber': str(number), 'gasUsed': str(used),
                                  'effectiveGasPriceWei': str(price), 'canonical': True, 'confirmations': 2}})
                return
        if not wait or time.monotonic() >= deadline:
            raise RuntimeError('FUNDING_BROADCAST_PENDING_NO_RESEND')
        time.sleep(3)


def cast_environment():
    # Prevent wallet/auth/sponsor/transaction environment settings from changing
    # this exact locally approved plain transfer. No secret value is logged.
    prefixes = ('ETH_', 'CAST_', 'FOUNDRY_', 'TEMPO_', 'TURNKEY_', 'AWS_KMS_')
    return {key: value for key, value in os.environ.items()
            if not key.startswith(prefixes) and key not in ('CHAIN', 'GCP_PROJECT_ID', 'GCP_LOCATION',
                                                           'GCP_KEY_RING', 'GCP_KEY_NAME', 'GCP_KEY_VERSION')}


def cast(arguments, directory, timeout=60):
    try:
        return subprocess.run(['cast', *arguments], cwd=directory, env=cast_environment(),
                              capture_output=True, text=True, timeout=timeout)
    except Exception:
        raise RuntimeError('FUNDING_CAST_EXECUTION_UNKNOWN_NO_RESEND') from None


def preflight(journal, remaining):
    check_chain()
    for destination in journal['identity']['targets'].values():
        need(rpc('eth_getCode', [destination, 'latest']) == '0x', 'FUNDING_TARGET_MUST_BE_EOA')
    need(rpc('eth_getCode', [DEPLOYER, 'latest']) == '0x', 'FUNDING_DEPLOYER_MUST_BE_EOA')
    nonce = quantity(rpc('eth_getTransactionCount', [DEPLOYER, 'latest']))
    need(quantity(rpc('eth_getTransactionCount', [DEPLOYER, 'pending'])) == nonce,
         'FUNDING_DEPLOYER_HAS_PENDING_TRANSACTIONS')
    balance = quantity(rpc('eth_getBalance', [DEPLOYER, 'latest']))
    need(balance >= sum(int(entry['valueWei']) + GAS * PRICE for entry in remaining) + RESERVE,
         'FUNDING_INSUFFICIENT_BALANCE_WITH_RESERVE')
    need(quantity(rpc('eth_gasPrice', [])) <= PRICE, 'FUNDING_NETWORK_GAS_ABOVE_APPROVED_PRICE')
    return nonce


def main():
    temporary = sys.argv[1]
    parser = argparse.ArgumentParser(description='Fund the fixed mainnet service wallets once; default offline plan.')
    parser.add_argument('--relay', required=True, help='New dedicated mainnet relay public EOA address')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--send', action='store_true')
    mode.add_argument('--plan', action='store_true')
    mode.add_argument('--status', action='store_true')
    mode.add_argument('--record-hash', metavar='ROLE:HASH', help='Read-only verify an unknown broadcast by its exact hash')
    args = parser.parse_args(sys.argv[2:])
    relay = address(args.relay)
    forbidden = [DEPLOYER, ASP, '0x42ce6Ece7DD3329880774c060cF158089b043EEf',
                 '0x36437b878415EdA1a24186CF79AFffBc9ecEd298', '0x9CF17a6E3c75D200f58283A165C442a8A3994555']
    need(relay not in [value.lower() for value in forbidden], 'FUNDING_RELAY_MUST_BE_DEDICATED')
    expected = identity(relay)
    if not (args.send or args.status or args.record_hash):
        emit({'schema': 'lincoln-mainnet-service-funding-plan/v1', **expected,
              'principalTotalWei': str(sum(map(int, AMOUNTS.values()))),
              'maximumTransferGasFeeWei': str(2 * GAS * PRICE), 'journal': str(STATE / 'journal.json'),
              'transactionsSigned': 0, 'transactionsBroadcast': 0, 'networkRequests': 0,
              'next': 'Run the same command with --send in your local terminal; enter the keystore password once.'})
        return
    private_directory(STATE)
    lockfd = os.open(STATE / '.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        lockstat = os.fstat(lockfd)
        need(stat.S_ISREG(lockstat.st_mode) and lockstat.st_uid == os.getuid() and lockstat.st_nlink == 1
             and stat.S_IMODE(lockstat.st_mode) == 0o600, 'FUNDING_UNSAFE_LOCK')
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        filename = STATE / 'journal.json'
        if filename.exists() or filename.is_symlink():
            journal = private_json(filename)
            need(journal.get('schema') == SCHEMA and journal.get('identity') == expected,
                 'FUNDING_EXISTING_JOURNAL_IDENTITY_MISMATCH')
        else:
            journal = {'schema': SCHEMA, 'identity': expected, 'createdAtUTC': timestamp(),
                       'entries': [{'role': role, 'to': expected['targets'][role], 'valueWei': AMOUNTS[role],
                                    'status': 'planned'} for role in ('relay', 'asp')]}
            save(journal)
        need(isinstance(journal.get('entries'), list) and len(journal['entries']) == 2,
             'FUNDING_JOURNAL_ENTRIES_INVALID')
        for role, entry in zip(('relay', 'asp'), journal['entries']):
            need(entry.get('role') == role and entry.get('to') == expected['targets'][role]
                 and entry.get('valueWei') == AMOUNTS[role]
                 and entry.get('status') in ('planned', 'broadcasting', 'submitted', 'unknown', 'confirmed', 'reverted'),
                 'FUNDING_JOURNAL_ENTRY_INVALID')
            if entry['status'] != 'planned':
                need(isinstance(entry.get('nonce'), str) and re.fullmatch(r'0|[1-9][0-9]*', entry['nonce']),
                     'FUNDING_JOURNAL_NONCE_REQUIRED')
        if args.status:
            emit({'schema': SCHEMA, 'chainId': CHAIN, 'entries': journal['entries'],
                  'transactionsSigned': 0, 'transactionsBroadcast': 0})
            return
        check_chain()
        if args.record_hash:
            match = re.fullmatch(r'(relay|asp):(0x[a-fA-F0-9]{64})', args.record_hash)
            need(match is not None, 'FUNDING_RECORD_HASH_ARGUMENT_INVALID')
            role, transaction_hash = match.groups()
            entry = next(entry for entry in journal['entries'] if entry['role'] == role)
            need(entry['status'] in ('broadcasting', 'submitted', 'unknown', 'confirmed'),
                 'FUNDING_NO_BROADCAST_TO_RECORD')
            need(entry.get('transactionHash') is None or same(entry['transactionHash'], transaction_hash),
                 'FUNDING_EXISTING_HASH_CANNOT_CHANGE')
            verify_transaction(entry, transaction_hash)
            entry['transactionHash'] = transaction_hash
            # A repeated manual hash check may fail on a transient RPC read;
            # keep an already confirmed terminal state rather than downgrading it.
            if entry['status'] != 'confirmed':
                entry['status'] = 'submitted'
            save(journal)
            reconcile(journal, entry, wait=False)
            return
        for entry in journal['entries']:
            if entry['status'] == 'reverted':
                raise RuntimeError('FUNDING_PREVIOUS_TRANSFER_REVERTED_NO_RESEND')
            if entry['status'] != 'planned':
                reconcile(journal, entry, wait=True)
        remaining = [entry for entry in journal['entries'] if entry['status'] == 'planned']
        if not remaining:
            emit({'complete': True, 'alreadyFunded': True, 'transactionsSigned': 0, 'transactionsBroadcast': 0})
            return
        preflight(journal, remaining)
        directory = Path(temporary).resolve()
        need(temporary and directory.is_dir() and stat.S_IMODE(directory.stat().st_mode) == 0o700
             and directory.stat().st_uid == os.getuid(), 'FUNDING_LOCAL_PASSWORD_DIRECTORY_REQUIRED')
        warnings.simplefilter('error', getpass.GetPassWarning)
        password = getpass.getpass('lincoln-deployer keystore password (local only): ')
        password_file = directory / 'password'
        descriptor = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(password)
        del password
        derived = cast(['wallet', 'address', '--account', ACCOUNT, '--password-file', str(password_file)], directory)
        need(derived.returncode == 0 and same(derived.stdout.strip(), DEPLOYER), 'FUNDING_KEYSTORE_ACCOUNT_MISMATCH')
        for index, entry in enumerate(remaining):
            nonce = preflight(journal, remaining[index:])
            start_block = quantity(rpc('eth_blockNumber', []))
            entry.update({'status': 'broadcasting', 'nonce': str(nonce), 'startedAtUTC': timestamp(),
                          'startBlock': str(start_block), 'gas': str(GAS), 'gasPriceWei': str(PRICE)})
            # Durable ambiguity marker comes BEFORE the single possible signing
            # and broadcast operation. A crash cannot leave a resubmittable plan.
            save(journal)
            try:
                sent = cast(['send', entry['to'], '--value', entry['valueWei'], '--data', '0x',
                             '--account', ACCOUNT, '--password-file', str(password_file), '--from', DEPLOYER,
                             '--rpc-url', RPC, '--chain', str(CHAIN), '--legacy', '--gas-limit', str(GAS),
                             '--gas-price', str(PRICE), '--nonce', str(nonce), '--async', '--rpc-timeout', '30'],
                            directory, timeout=60)
            except Exception:
                entry['status'] = 'unknown'
                save(journal)
                raise
            output = sent.stdout.strip()
            try:
                parsed = json.loads(output)
                if isinstance(parsed, str):
                    output = parsed
            except ValueError:
                pass
            if re.fullmatch(r'0x[0-9a-fA-F]{64}', output):
                entry['transactionHash'] = output
            entry['status'] = 'submitted' if sent.returncode == 0 and entry.get('transactionHash') else 'unknown'
            save(journal)
            if entry.get('transactionHash'):
                emit({'role': entry['role'], 'transactionHash': entry['transactionHash']})
            need(entry['status'] == 'submitted', 'FUNDING_BROADCAST_UNKNOWN_NO_RESEND')
            reconcile(journal, entry, wait=True)
        emit({'complete': True, 'chainId': CHAIN, 'principalTotalWei': str(sum(map(int, AMOUNTS.values()))),
              'transferGasFeeWei': str(sum(int(entry['feeWei']) for entry in journal['entries'])),
              'journal': str(filename), 'automaticResend': False})
    finally:
        os.close(lockfd)


try:
    main()
except Exception as error:
    code = str(error)
    if not re.fullmatch(r'FUNDING_[A-Z_]+', code):
        code = 'FUNDING_STOPPED_REQUIRES_REVIEW'
    emit({'error': code, 'automaticResend': False, 'journal': str(STATE / 'journal.json'),
          'next': 'Do not delete/reset the journal or repeat a transfer manually. Resolve the recorded hash or nonce first.'})
    raise SystemExit(1)
PY
