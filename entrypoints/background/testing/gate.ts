export function isTestControlPlaneEnabled() {
  const globalOverride = (globalThis as { __JOT_TEST_CONTROL_PLANE_ENABLED__?: boolean })
    .__JOT_TEST_CONTROL_PLANE_ENABLED__;

  if (typeof globalOverride === 'boolean') {
    return globalOverride;
  }

  return import.meta.env.MODE !== 'production';
}
