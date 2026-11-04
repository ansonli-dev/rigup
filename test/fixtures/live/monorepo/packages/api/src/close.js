export function closeAccount(account) {
  if (account.balance !== 0) return {status: 409, error: {code: 'BALANCE_REMAINS', message: 'Settle balance first'}};
  return {status: 200, body: {...account, closed: true}};
}
