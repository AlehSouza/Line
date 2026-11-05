export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, 'not_found', `${what} não encontrado`);
export const forbidden = (message = 'Você não tem permissão para isso') => new HttpError(403, 'forbidden', message);
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const unauthorized = (message = 'Sessão inválida, entre novamente') =>
  new HttpError(401, 'unauthorized', message);
