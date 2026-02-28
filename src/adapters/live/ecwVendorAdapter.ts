import { config } from '../../config';
import { AdapterEventPull, EventRecord } from '../../types/domain';
import { ClinicalDataAdapter } from '../types';

const requireConfiguredBaseUrl = (): string => {
  if (!config.ecwBaseUrl) {
    throw new Error('ECW_BASE_URL is required for live vendor adapter mode.');
  }
  return config.ecwBaseUrl.replace(/\/$/, '');
};

export class EcwVendorAdapterStub implements ClinicalDataAdapter {
  mode: 'live' = 'live';

  private async callVendor(path: string, params: AdapterEventPull): Promise<EventRecord[]> {
    const baseUrl = requireConfiguredBaseUrl();
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        tenant: config.ecwTenant,
        start: params.start,
        end: params.end
      })
    });

    if (!response.ok) {
      throw new Error(`eClinicalWorks vendor endpoint failed: ${response.status}`);
    }

    // TODO: map vendor-specific payloads into EventRecord.
    return [];
  }

  async fetchPortalMessages(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.callVendor('/portal/messages', params);
  }

  async fetchRefillRequests(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.callVendor('/medications/refills', params);
  }

  async fetchEncounterDiagnoses(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.callVendor('/encounters/diagnoses', params);
  }

  async fetchAppointments(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.callVendor('/appointments', params);
  }

  async fetchLabsAndVitals(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.callVendor('/observations/labs-vitals', params);
  }

  async fetchClaimsOrCharges(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.callVendor('/claims', params);
  }
}
