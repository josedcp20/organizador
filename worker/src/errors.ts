export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}
