const Apify = require('apify');
const { TYPES, LABELS, ORIGIN, Input } = require('./constants');

const fns = require('./functions');

const { utils: { log } } = Apify;

const {
    getUrlData,
    extendFunction,
    isOverItems,
    // eslint-disable-next-line no-unused-vars
    createGetSimpleResult,
} = fns;

/**
 * Throws error if the provided input is invalid.
 * @param {{ search: String, startUrls: any[], zpids: any[], zipcodes: any[] }} input
 */
const validateInput = (input) => {
    if (!(input.search && input.search.trim().length > 0)
        && !(input.startUrls?.length)
        && !(input.zpids?.length)
        && !(input.zipcodes?.length)
    ) {
        throw new Error('Either "search", "startUrls", "zipcodes" or "zpids" attribute has to be set!');
    }
};

/**
 * Removes pagination for given URL
 * @param {string} url
 */
const cleanUpUrl = (url) => {
    const nUrl = new URL(url, ORIGIN);
    /** @type {import('./constants').SearchQueryState | null} */
    let searchQueryState = null;
    nUrl.pathname = '/homes/';

    // pagination on the JSON variable
    if (nUrl.searchParams.has('searchQueryState')) {
        searchQueryState = JSON.parse(nUrl.searchParams.get('searchQueryState'));

        nUrl.searchParams.set('searchQueryState', JSON.stringify({
            ...searchQueryState,
            pagination: {},
        }));
    }

    return {
        url: nUrl,
        searchQueryState,
    };
};

/**
 * Lazy load the RequestQueue. Can take a while depending of the number
 * of URLs from input and the handlePageFunction might timeout
 *
 * @param {Input} input
 * @param {Apify.RequestQueue} rq
 */
const getInitializedStartUrls = (input, rq) => async () => {
    if (input.search?.trim()) {
        const term = input.search.trim();

        await rq.addRequest({
            url: 'https://www.zillow.com/homes/sold/70769_rb/',
            uniqueKey: `${term}`,
            userData: {
                label: LABELS.SEARCH,
                term,
            },
        });
    }

    if (input.startUrls?.length) {
        if (input.type) {
            log.warning(`Input type "${input.type}" will be ignored as the value is derived from start url.
             Check if your start urls match the desired home status.`);
        }

        const requestList = await Apify.openRequestList('STARTURLS', input.startUrls);

        /**
         * requestList.fetchNextRequest() gets Request object from requestsFromUrl property
         * which holds start url parsed by RequestList
         */
        let req;
        while (req = await requestList.fetchNextRequest()) { // eslint-disable-line no-cond-assign
            if (!req.url.includes('zillow.com')) {
                throw new Error(`Invalid startUrl ${req.url}. Url must start with: https://www.zillow.com`);
            }

            const userData = getUrlData(req.url);
            const { url, searchQueryState } = cleanUpUrl(req.url);

            const uniqueKey = (() => {
                if (searchQueryState) {
                    return fns.getUniqueKeyFromQueryState(searchQueryState);
                }

                return url;
            })();

            await rq.addRequest({
                url: url.toString(),
                userData,
                uniqueKey: `${userData.zpid || uniqueKey}`,
            });
        }
    }

    if (input.zpids?.length) {
        await rq.addRequest({
            url: 'https://www.zillow.com/',
            uniqueKey: 'ZPIDS',
            userData: {
                label: LABELS.ZPIDS,
                zpids: [].concat(input.zpids).filter((value) => /^\d+$/.test(value)),
            },
        });
    }

    if (input.zipcodes?.length) {
        log.info(`Trying to add ${input.zipcodes.length} zipcodes`);
        let count = 0;

        for (const zipcode of input.zipcodes) {
            // simple regex for testing the 5 digit zipcodes
            if (/^(?!0{3})[0-9]{3,5}$/.test(zipcode)) {
                const cleanZip = `${zipcode}`.replace(/[^\d]+/g, '');

                const result = await rq.addRequest({
                    url: `https://www.zillow.com/homes/${cleanZip}_rb/`,
                    uniqueKey: `ZIP${cleanZip}`,
                    userData: {
                        label: LABELS.QUERY,
                        zipcode: cleanZip,
                    },
                });

                if (!result.wasAlreadyPresent) {
                    count++;
                }
            } else {
                throw new Error(`Invalid zipcode provided: ${zipcode}`);
            }
        }

        log.info(`Added ${count} zipcodes`);
    }
};

/**
 *
 * @param {{ debugLog: boolean, handlePageTimeoutSecs: any}} input
 * @returns initialized preLaunchHooks
 */
const initializePreLaunchHooks = (input) => {
    return [async (/** @type {any} */ _pageId, /** @type {{ launchOptions: any; }} */ launchContext) => {
        launchContext.launchOptions = {
            ...launchContext.launchOptions,
            bypassCSP: true,
            ignoreHTTPSErrors: true,
            devtools: input.debugLog,
            headless: false,
        };
    }];
};

/**
 *
 * @param {{
 *  zpids: Set<any>,
 *  input: {
 *      maxItems: Number,
 *      startUrls: Array<Apify.RequestOptions>,
 *      type: String
 *  },
 * }} globalContext
 * @param {*} minMaxDate
 * @param {ReturnType<createGetSimpleResult>} getSimpleResult
 * @returns
 */
const getExtendOutputFunction = async ({ zpids, input }, minMaxDate, getSimpleResult) => {
    const extendOutputFunction = await extendFunction({
        map: async (data) => getSimpleResult(data),
        filter: async ({ data }, { request }) => {
                            
            if (isOverItems({ zpids, input })) {
                return false;
            }

            if (!data?.zpid) {
                return false;
            }

            if (!minMaxDate.compare(data.datePosted) || zpids.has(`${data.zpid}`)) {
                return false;
            }

            if (request.userData.ignoreFilter === true) {
                // ignore input.type when it is set in start url
                return true;
            }

            switch (input.type) {
                case 'sale':
                    return data.homeStatus === 'FOR_SALE';
                case 'fsbo':
                    return data.homeStatus === 'FOR_SALE' && data.keystoneHomeStatus === 'ForSaleByOwner';
                case 'rent':
                    return data.homeStatus === 'FOR_RENT';
                case 'sold':
                    return data.homeStatus?.includes('SOLD');
                case 'all':
                default:
                    return true;
            }
        },
        output: async (output, { data }) => {
            if (data.zpid && !isOverItems({ zpids, input })) {
                zpids.add(`${data.zpid}`);
                await Apify.pushData(output);
            }
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            getUrlData,
            getSimpleResult,
            zpids,
            minMaxDate,
            TYPES,
            fns,
            LABELS,
        },
    });

    return extendOutputFunction;
};

/**
 *
 * @param {{ simple: boolean }} input
 * @returns getSimpleResult function
 */
const getSimpleResultFunction = (input) => {
    // Toggle showing only a subset of result attributes

    const simpleResult = {
        address: true,
        bedrooms: true,
        bathrooms: true,
        price: true,
        yearBuilt: true,
        longitude: true,
        homeStatus: true,
        latitude: true,
        description: true,
        livingArea: true,
        currency: true,
        hdpUrl: true,
        responsivePhotos: true,
    };

    const getSimpleResult = createGetSimpleResult(
        input.simple
            ? simpleResult
            : {
                ...simpleResult,
                datePosted: true,
                isZillowOwned: true,
                priceHistory: true,
                zpid: true,
                isPremierBuilder: true,
                primaryPublicVideo: true,
                tourViewCount: true,
                postingContact: true,
                unassistedShowing: true,
                homeType: true,
                comingSoonOnMarketDate: true,
                timeZone: true,
                newConstructionType: true,
                moveInReady: true,
                moveInCompletionDate: true,
                lastSoldPrice: true,
                contingentListingType: true,
                zestimate: true,
                zestimateLowPercent: true,
                zestimateHighPercent: true,
                rentZestimate: true,
                restimateLowPercent: true,
                restimateHighPercent: true,
                solarPotential: true,
                brokerId: true,
                parcelId: true,
                homeFacts: true,
                taxAssessedValue: true,
                taxAssessedYear: true,
                isPreforeclosureAuction: true,
                listingProvider: true,
                marketingName: true,
                building: true,
                priceChange: true,
                datePriceChanged: true,
                dateSold: true,
                lotSize: true,
                hoaFee: true,
                mortgageRates: true,
                propertyTaxRate: true,
                whatILove: true,
                isFeatured: true,
                isListedByOwner: true,
                isCommunityPillar: true,
                pageViewCount: true,
                favoriteCount: true,
                openHouseSchedule: true,
                brokerageName: true,
                taxHistory: true,
                abbreviatedAddress: true,
                ownerAccount: true,
                isRecentStatusChange: true,
                isNonOwnerOccupied: true,
                buildingId: true,
                daysOnZillow: true,
                rentalApplicationsAcceptedType: true,
                buildingPermits: true,
                highlights: true,
                tourEligibility: true,
            },
    );

    return getSimpleResult;
};

module.exports = {
    validateInput,
    getInitializedStartUrls,
    initializePreLaunchHooks,
    getSimpleResultFunction,
    getExtendOutputFunction,
};
