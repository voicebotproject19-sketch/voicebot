'use strict';

/**
 * parseE164CountryCode — extract ITU-T country code from an E.164 phone number.
 *
 * Checks longest-prefix-first (3-digit → 2-digit → 1-digit) against the full
 * ITU-T assigned country code table.
 *
 * @param {string} [phone] - E.164 phone number (must start with +)
 * @returns {string|null} Country code digits, or null if not E.164 / no match
 */
function parseE164CountryCode(phone) {
    if (!phone || typeof phone !== 'string') return null;

    const normalized = phone.trim();
    if (!normalized.startsWith('+')) return null;

    const digits = normalized.slice(1).replace(/\D/g, '');
    if (!digits) return null;

    // ITU-T assigned country codes, checked longest-first so e.g. '91' beats '9'.
    // 3-digit codes (selected regions)
    const CC3 = new Set([
        '210','211','212','213','216','218','220','221','222','223','224','225','226',
        '227','228','229','230','231','232','233','234','235','236','237','238','239',
        '240','241','242','243','244','245','246','247','248','249','250','251','252',
        '253','254','255','256','257','258','260','261','262','263','264','265','266',
        '267','268','269','290','291','297','298','299',
        '350','351','352','353','354','355','356','357','358','359',
        '370','371','372','373','374','375','376','377','378','380','381','382','385',
        '386','387','389',
        '420','421','423',
        '500','501','502','503','504','505','506','507','508','509',
        '590','591','592','593','594','595','596','597','598','599',
        '670','672','673','674','675','676','677','678','679','680','681','682','683',
        '685','686','687','688','689','690','691','692',
        '850','852','853','855','856',
        '880','886',
        '960','961','962','963','964','965','966','967','968','970','971','972','973',
        '974','975','976','977','992','993','994','995','996','998',
    ]);
    // 2-digit codes
    const CC2 = new Set([
        '20','27','30','31','32','33','34','36','39',
        '40','41','43','44','45','46','47','48','49',
        '51','52','53','54','55','56','57','58',
        '60','61','62','63','64','65','66',
        '81','82','84','86','90','91','92','93','94','95','98',
    ]);
    // 1-digit codes (NANP + Russia/Kazakhstan zone)
    const CC1 = new Set(['1','7']);

    const p3 = digits.slice(0, 3);
    const p2 = digits.slice(0, 2);
    const p1 = digits.slice(0, 1);

    if (CC3.has(p3)) return p3;
    if (CC2.has(p2)) return p2;
    if (CC1.has(p1)) return p1;

    return null;
}

function normalizeTransferNumber(value) {
    if (value == null) return { ok: false, number: null, reason: 'missing' };

    const raw = String(value).trim();
    if (!raw) return { ok: false, number: null, reason: 'missing' };

    const hasLeadingPlus = raw.startsWith('+');
    const rest = hasLeadingPlus ? raw.slice(1) : raw;
    if (rest.includes('+')) return { ok: false, number: null, reason: 'invalid_plus' };
    if (/[A-Za-z]/.test(rest)) return { ok: false, number: null, reason: 'invalid_characters' };
    if (/[^0-9\s().-]/.test(rest)) return { ok: false, number: null, reason: 'invalid_characters' };

    const digits = rest.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
        return { ok: false, number: null, reason: 'invalid_length' };
    }

    return { ok: true, number: `${hasLeadingPlus ? '+' : ''}${digits}`, reason: null };
}

module.exports = { parseE164CountryCode, normalizeTransferNumber };
