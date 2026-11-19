import { requireChatGPTUser } from './chatgpt-auth';
import { bindOwner } from '@/lib/cloud-store';
import AtlasClient from './AtlasClient';
export const dynamic='force-dynamic';
export default async function Home(){const user=await requireChatGPTUser('/');await bindOwner(user.userId);return <AtlasClient/>;}
