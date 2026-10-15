/** Geographic search partitions keep the requested country while opening new SERPs. */
const US_STATES = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
    'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
    'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
    'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
    'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
    'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
    'Wisconsin', 'Wyoming', 'District of Columbia',
];
const CANADIAN_REGIONS = [
    'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador',
    'Nova Scotia', 'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan',
    'Northwest Territories', 'Nunavut', 'Yukon',
];

export function countrySearchExpansion(location: string) {
    const key = location.toLowerCase().replace(/[^a-z]/g, '');
    if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica'].includes(key)) {
        return {
            country: 'US',
            aliases: ['US', 'United States', 'USA'].filter(alias => alias.toLowerCase().replace(/[^a-z]/g, '') !== key),
            constraint: '("United States" OR "USA" OR "US")',
            regions: US_STATES,
        };
    }
    if (['canada', 'ca', 'can'].includes(key)) {
        return { country: 'CA', aliases: key === 'canada' ? [] : ['Canada'], constraint: '"Canada"', regions: CANADIAN_REGIONS };
    }
    return null;
}
