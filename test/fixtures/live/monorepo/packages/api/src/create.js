export function createAccount(input) {
  if (!input.email) return {status: 422, error: {code: 'EMAIL_REQUIRED', message: 'Email is required'}};
  return {status: 201, body: {id: input.id}};
}
