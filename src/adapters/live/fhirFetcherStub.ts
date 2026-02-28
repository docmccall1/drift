import { config } from '../../config';
import { AdapterEventPull, EventRecord } from '../../types/domain';
import { ClinicalDataAdapter } from '../types';

const mapFhirResourceToEvents = (_resourceType: string, _bundle: unknown): EventRecord[] => {
  return [];
};

export class FhirR4FetcherStub implements ClinicalDataAdapter {
  mode: 'live' = 'live';

  private async fetchResource(resourceType: string, params: AdapterEventPull): Promise<EventRecord[]> {
    if (!config.ecwBaseUrl) {
      return [];
    }

    const url = new URL(`${config.ecwBaseUrl.replace(/\/$/, '')}/fhir/R4/${resourceType}`);
    url.searchParams.set('_lastUpdated', `ge${params.start}`);
    url.searchParams.append('_lastUpdated', `lt${params.end}`);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/fhir+json'
      }
    });

    if (!response.ok) {
      throw new Error(`FHIR fetch failed for ${resourceType}: ${response.status}`);
    }

    const bundle = await response.json();
    return mapFhirResourceToEvents(resourceType, bundle);
  }

  async fetchPortalMessages(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.fetchResource('Communication', params);
  }

  async fetchRefillRequests(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.fetchResource('MedicationRequest', params);
  }

  async fetchEncounterDiagnoses(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.fetchResource('Encounter', params);
  }

  async fetchAppointments(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.fetchResource('Appointment', params);
  }

  async fetchLabsAndVitals(params: AdapterEventPull): Promise<EventRecord[]> {
    const [observations] = await Promise.all([this.fetchResource('Observation', params)]);
    return observations;
  }

  async fetchClaimsOrCharges(params: AdapterEventPull): Promise<EventRecord[]> {
    return this.fetchResource('Claim', params);
  }
}
