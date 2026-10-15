import { readBusinessSnapshot } from '../../business-store';
import { toOnboardingBrief } from '../shared/onboarding';

export async function readCopyStudioOnboardings() {
  const snapshot = await readBusinessSnapshot();
  return snapshot.projects.flatMap((project) => {
    const brief = toOnboardingBrief(project);
    return brief ? [brief] : [];
  });
}
