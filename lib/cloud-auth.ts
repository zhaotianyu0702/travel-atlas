import { bindOwner } from './cloud-store';

export async function authorize(request: Request): Promise<Response | null> {
  const user = request.headers.get('oai-authenticated-user-id');
  if (!user) return Response.json({error:'Sign in to continue'}, {status:401,headers:{'Cache-Control':'private, no-store'}});
  try { await bindOwner(user); } catch { return Response.json({error:'Access denied'}, {status:403}); }
  if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if ((origin && new URL(origin).origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({error:'Invalid request origin'}, {status:403});
  }
  return null;
}
