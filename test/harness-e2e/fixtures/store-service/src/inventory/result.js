export function success(value) {
  return {ok: true, value};
}

export function failure(code, message) {
  return {ok: false, error: {code, message}};
}
