import { requireChatGPTUser } from '../chatgpt-auth';
import { bindOwner } from '@/lib/cloud-store';
import LocationCheck from './LocationCheck';

export const dynamic = 'force-dynamic';
export default async function Page() {
  const user = await requireChatGPTUser('/location-check');
  await bindOwner(user.userId);
  return <LocationCheck/>;
}
