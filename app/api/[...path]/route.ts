import { authorize } from '@/lib/cloud-auth';
import { routeApi } from '@/lib/cloud-api';
import { locationRoute, locationProbeRoute } from '@/lib/cloud-location';
import { highlightsRoute } from '@/lib/cloud-highlights';
import { aiRoute } from '@/lib/cloud-ai';
import { exportRoute } from '@/lib/cloud-export';
import { migrationRoute } from '@/lib/cloud-migration';

export const dynamic = 'force-dynamic';
async function handle(request: Request, context: {params:Promise<{path:string[]}>}) {
  try {
    const {path} = await context.params;
    if(path[0]==='admin'&&path[1]==='migrate') return await migrationRoute(request);
    const denied=await authorize(request); if(denied)return denied;
    if(path[0]==='ai') {const response=await (path[1]==='locations' ? locationRoute(request,path) : path[1]==='highlights' ? highlightsRoute(request,path) : path.length===2&&path[1]==='location-probe' ? locationProbeRoute(request) : aiRoute(request,path));response.headers.set('Cache-Control','private, no-store');return response;}
    if(path[0]==='export') return await exportRoute(request,path);
    return await routeApi(request,path);
  } catch(error) {
    const message=error instanceof Error?error.message:'Request failed';
    const status=/not found|no longer exists/i.test(message)?404:400;
    return Response.json({error:message},{status,headers:{'Cache-Control':'private, no-store'}});
  }
}
export {handle as GET,handle as POST,handle as PUT,handle as PATCH,handle as DELETE};
