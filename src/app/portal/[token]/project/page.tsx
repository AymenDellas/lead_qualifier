import { notFound } from 'next/navigation';
import { readProjectPortal } from '@/lib/project-portal-store';
import ProjectClientWorkspace from '@/components/business/ProjectClientWorkspace';
export const dynamic = 'force-dynamic';
export default async function ProjectPortalPage({ params }: {params:Promise<{token:string}>}) {
  const { token } = await params;
  const data = await readProjectPortal(token);
  if (!data) notFound();
  return <ProjectClientWorkspace token={token} project={data.view} files={data.files} onboardingTasks={data.onboardingTasks} />;
}
