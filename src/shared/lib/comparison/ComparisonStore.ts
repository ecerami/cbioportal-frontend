import {
    ClinicalDataEnrichmentWithQ,
    ComparisonGroup,
    CopyNumberEnrichment,
    defaultGroupOrder,
    finalizeStudiesAttr,
    getNumSamples,
    getOrdinals,
    getOverlapComputations,
    getSampleIdentifiers,
    getStudyIds,
    IOverlapComputations,
    isGroupEmpty,
    partitionCasesByGroupMembership,
} from '../../../pages/groupComparison/GroupComparisonUtils';
import { GroupComparisonTab } from '../../../pages/groupComparison/GroupComparisonTabs';
import {
    remoteData,
    stringListToIndexSet,
} from '../../../../packages/cbioportal-frontend-commons/dist';
import {
    CancerStudy,
    ClinicalAttribute,
    ClinicalData,
    ClinicalDataMultiStudyFilter,
    MolecularProfile,
    MolecularProfileFilter,
    ReferenceGenomeGene,
    Sample,
    SampleFilter,
} from '../../api/generated/CBioPortalAPI';
import { action, autorun, computed, IReactionDisposer, observable } from 'mobx';
import client from '../../api/cbioportalClientInstance';
import comparisonClient from '../../api/comparisonGroupClientInstance';
import _ from 'lodash';
import {
    pickCopyNumberEnrichmentProfiles,
    pickMRNAEnrichmentProfiles,
    pickMutationEnrichmentProfiles,
    pickProteinEnrichmentProfiles,
} from '../../../pages/resultsView/enrichments/EnrichmentsUtil';
import { makeEnrichmentDataPromise } from '../../../pages/resultsView/ResultsViewPageStoreUtils';
import internalClient from '../../api/cbioportalInternalClientInstance';
import autobind from 'autobind-decorator';
import { PatientSurvival } from 'shared/model/PatientSurvival';
import request from 'superagent';
import { getPatientSurvivals } from 'pages/resultsView/SurvivalStoreHelper';
import { SURVIVAL_CHART_ATTRIBUTES } from 'pages/resultsView/survival/SurvivalChart';
import {
    getPatientIdentifiers,
    pickClinicalDataColors,
} from 'pages/studyView/StudyViewUtils';
import {
    AlterationEnrichment,
    Group,
    MolecularProfileCasesGroupFilter,
} from '../../api/generated/CBioPortalAPIInternal';
import { Session, SessionGroupData } from '../../api/ComparisonGroupClient';
import { calculateQValues } from 'shared/lib/calculation/BenjaminiHochbergFDRCalculator';
import ComplexKeyMap from '../complexKeyDataStructures/ComplexKeyMap';
import ComplexKeyGroupsMap from '../complexKeyDataStructures/ComplexKeyGroupsMap';
import { AppStore } from '../../../AppStore';
import { GACustomFieldsEnum, trackEvent } from 'shared/lib/tracking';
import ifNotDefined from '../ifNotDefined';
import { ISurvivalDescription } from 'pages/resultsView/survival/SurvivalDescriptionTable';
import { fetchAllReferenceGenomeGenes } from 'shared/lib/StoreUtils';
import MobxPromise from 'mobxpromise';
import ResultsViewURLWrapper from '../../../pages/resultsView/ResultsViewURLWrapper';
import { ResultsViewPageStore } from '../../../pages/resultsView/ResultsViewPageStore';

export enum OverlapStrategy {
    INCLUDE = 'Include',
    EXCLUDE = 'Exclude',
}

export default class ComparisonStore {
    private tabHasBeenShown = observable.map<boolean>();
    private tabHasBeenShownReactionDisposer: IReactionDisposer;

    constructor(
        protected appStore: AppStore,
        protected resultsViewStore?: ResultsViewPageStore
    ) {
        setTimeout(() => {
            this.tabHasBeenShownReactionDisposer = autorun(() => {
                this.tabHasBeenShown.set(
                    GroupComparisonTab.SURVIVAL,
                    !!this.tabHasBeenShown.get(GroupComparisonTab.SURVIVAL) ||
                        this.showSurvivalTab
                );
                this.tabHasBeenShown.set(
                    GroupComparisonTab.MUTATIONS,
                    !!this.tabHasBeenShown.get(GroupComparisonTab.MUTATIONS) ||
                        this.showMutationsTab
                );
                this.tabHasBeenShown.set(
                    GroupComparisonTab.CNA,
                    !!this.tabHasBeenShown.get(GroupComparisonTab.CNA) ||
                        this.showCopyNumberTab
                );
                this.tabHasBeenShown.set(
                    GroupComparisonTab.MRNA,
                    !!this.tabHasBeenShown.get(GroupComparisonTab.MRNA) ||
                        this.showMRNATab
                );
                this.tabHasBeenShown.set(
                    GroupComparisonTab.PROTEIN,
                    !!this.tabHasBeenShown.get(GroupComparisonTab.PROTEIN) ||
                        this.showProteinTab
                );
            });
        }); // do this after timeout so that all subclasses have time to construct
    }

    public destroy() {
        this.tabHasBeenShownReactionDisposer &&
            this.tabHasBeenShownReactionDisposer();
    }

    // < To be implemented in subclasses: >
    public isGroupSelected(name: string): boolean {
        throw 'isGroupSelected must be implemented in subclass';
    }
    public setUsePatientLevelEnrichments(s: boolean) {
        throw 'setUsePatientLevelEnrichments must be implemented in subclass';
    }

    readonly _originalGroups: MobxPromise<ComparisonGroup[]>; // must be implemented in subclasses
    public overlapStrategy: OverlapStrategy; // must be implemented in subclasses
    public usePatientLevelEnrichments: boolean; // must be implemented in subclasses
    readonly samples: MobxPromise<Sample[]>; // must be implemented in subclass
    readonly studies: MobxPromise<CancerStudy[]>; // must be implemented in subclass
    // < / >

    readonly overlapComputations = remoteData<
        IOverlapComputations<ComparisonGroup>
    >({
        await: () => [this._originalGroups],
        invoke: () => {
            return Promise.resolve(
                getOverlapComputations(
                    this._originalGroups.result!,
                    this.isGroupSelected
                )
            );
        },
    });

    readonly availableGroups = remoteData<ComparisonGroup[]>({
        await: () => [this._originalGroups, this._originalGroupsOverlapRemoved],
        invoke: () => {
            let ret: ComparisonGroup[];
            switch (this.overlapStrategy) {
                case OverlapStrategy.INCLUDE:
                    ret = this._originalGroups.result!;
                    break;
                case OverlapStrategy.EXCLUDE:
                default:
                    ret = this._originalGroupsOverlapRemoved.result!;
                    break;
            }
            return Promise.resolve(ret);
        },
    });

    readonly activeGroups = remoteData<ComparisonGroup[]>({
        await: () => [this.availableGroups],
        invoke: () =>
            Promise.resolve(
                this.availableGroups.result!.filter(
                    group =>
                        this.isGroupSelected(group.uid) && !isGroupEmpty(group)
                )
            ),
    });

    readonly enrichmentAnalysisGroups = remoteData({
        await: () => [this.activeGroups, this.sampleSet],
        invoke: () => {
            const sampleSet =
                this.sampleSet.result || new ComplexKeyMap<Sample>();
            const groups = this.activeGroups.result!.map(group => {
                const samples: Sample[] = [];
                group.studies.forEach(studyEntry => {
                    const studyId = studyEntry.id;
                    studyEntry.samples.forEach(sampleId => {
                        if (sampleSet.has({ studyId: studyId, sampleId })) {
                            const sample = sampleSet.get({
                                studyId: studyId,
                                sampleId,
                            })!;
                            samples.push(sample);
                        }
                    });
                });
                return {
                    name: group.nameWithOrdinal,
                    description: '',
                    count: getNumSamples(group),
                    color: group.color,
                    samples,
                    nameOfEnrichmentDirection: group.nameOfEnrichmentDirection,
                };
            });
            return Promise.resolve(groups);
        },
    });

    readonly _originalGroupsOverlapRemoved = remoteData<ComparisonGroup[]>({
        await: () => [this.overlapComputations, this._originalGroups],
        invoke: () => Promise.resolve(this.overlapComputations.result!.groups),
    });

    readonly _activeGroupsOverlapRemoved = remoteData<ComparisonGroup[]>({
        await: () => [this._originalGroupsOverlapRemoved],
        invoke: () =>
            Promise.resolve(
                this._originalGroupsOverlapRemoved.result!.filter(
                    group =>
                        this.isGroupSelected(group.uid) && !isGroupEmpty(group)
                )
            ),
    });

    readonly _activeGroupsNotOverlapRemoved = remoteData({
        await: () => [this._originalGroups, this.overlapComputations],
        invoke: () => {
            let excludedGroups = this.overlapComputations.result!
                .excludedFromAnalysis;
            if (this.overlapStrategy === OverlapStrategy.INCLUDE) {
                excludedGroups = {};
            }
            return Promise.resolve(
                this._originalGroups.result!.filter(
                    group =>
                        this.isGroupSelected(group.uid) &&
                        !(group.uid in excludedGroups)
                )
            );
        },
    });

    readonly _selectedGroups = remoteData({
        await: () => [this._originalGroups],
        invoke: () =>
            Promise.resolve(
                this._originalGroups.result!.filter(group =>
                    this.isGroupSelected(group.uid)
                )
            ),
    });

    readonly activeSamplesNotOverlapRemoved = remoteData({
        await: () => [this.sampleSet, this._activeGroupsNotOverlapRemoved],
        invoke: () => {
            const activeSampleIdentifiers = getSampleIdentifiers(
                this._activeGroupsNotOverlapRemoved.result!
            );
            const sampleSet = this.sampleSet.result!;
            return Promise.resolve(
                activeSampleIdentifiers.map(
                    sampleIdentifier => sampleSet.get(sampleIdentifier)!
                )
            );
        },
    });

    readonly activePatientKeysNotOverlapRemoved = remoteData({
        await: () => [this.activeSamplesNotOverlapRemoved],
        invoke: () =>
            Promise.resolve(
                _.uniq(
                    this.activeSamplesNotOverlapRemoved.result!.map(
                        s => s.uniquePatientKey
                    )
                )
            ),
    });

    readonly activeStudyIds = remoteData({
        await: () => [this.activeGroups],
        invoke: () => Promise.resolve(getStudyIds(this.activeGroups.result!)),
    });

    readonly molecularProfilesInActiveStudies = remoteData<MolecularProfile[]>(
        {
            await: () => [this.activeStudyIds],
            invoke: async () => {
                if (this.activeStudyIds.result!.length > 0) {
                    return client.fetchMolecularProfilesUsingPOST({
                        molecularProfileFilter: {
                            studyIds: this.activeStudyIds.result!,
                        } as MolecularProfileFilter,
                    });
                } else {
                    return Promise.resolve([]);
                }
            },
        },
        []
    );

    readonly referenceGenes = remoteData<ReferenceGenomeGene[]>({
        await: () => [this.studies],
        invoke: () => {
            if (this.studies.result!.length > 0) {
                return fetchAllReferenceGenomeGenes(
                    this.studies.result![0].referenceGenome
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly hugoGeneSymbolToReferenceGene = remoteData<{
        [hugoSymbol: string]: ReferenceGenomeGene;
    }>({
        await: () => [this.referenceGenes],
        invoke: () => {
            // build reference gene map
            return Promise.resolve(
                _.keyBy(this.referenceGenes.result!, g => g.hugoGeneSymbol)
            );
        },
    });

    public readonly mutationEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () =>
            Promise.resolve(
                pickMutationEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                )
            ),
    });

    public readonly copyNumberEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () =>
            Promise.resolve(
                pickCopyNumberEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                )
            ),
    });

    public readonly mRNAEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () =>
            Promise.resolve(
                pickMRNAEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                )
            ),
    });

    public readonly proteinEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () =>
            Promise.resolve(
                pickProteinEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                )
            ),
    });

    @observable.ref private _mutationEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref private _copyNumberEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref private _mRNAEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref private _proteinEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};

    readonly selectedStudyMutationEnrichmentProfileMap = remoteData({
        await: () => [this.mutationEnrichmentProfiles],
        invoke: () => {
            if (_.isEmpty(this._mutationEnrichmentProfileMap)) {
                const molecularProfilesbyStudyId = _.groupBy(
                    this.mutationEnrichmentProfiles.result!,
                    profile => profile.studyId
                );
                // Select only one molecular profile for each study
                return Promise.resolve(
                    _.mapValues(
                        molecularProfilesbyStudyId,
                        molecularProfiles => molecularProfiles[0]
                    )
                );
            } else {
                return Promise.resolve(this._mutationEnrichmentProfileMap);
            }
        },
    });

    readonly selectedStudyCopyNumberEnrichmentProfileMap = remoteData({
        await: () => [this.copyNumberEnrichmentProfiles],
        invoke: () => {
            if (_.isEmpty(this._copyNumberEnrichmentProfileMap)) {
                const molecularProfilesbyStudyId = _.groupBy(
                    this.copyNumberEnrichmentProfiles.result!,
                    profile => profile.studyId
                );
                // Select only one molecular profile for each study
                return Promise.resolve(
                    _.mapValues(
                        molecularProfilesbyStudyId,
                        molecularProfiles => molecularProfiles[0]
                    )
                );
            } else {
                return Promise.resolve(this._copyNumberEnrichmentProfileMap);
            }
        },
    });

    readonly selectedmRNAEnrichmentProfileMap = remoteData({
        await: () => [this.mRNAEnrichmentProfiles],
        invoke: () => {
            if (_.isEmpty(this._mRNAEnrichmentProfileMap)) {
                const molecularProfilesbyStudyId = _.groupBy(
                    this.mRNAEnrichmentProfiles.result!,
                    profile => profile.studyId
                );
                // Select only one molecular profile for each study
                return Promise.resolve(
                    _.mapValues(
                        molecularProfilesbyStudyId,
                        molecularProfiles => molecularProfiles[0]
                    )
                );
            } else {
                return Promise.resolve(this._mRNAEnrichmentProfileMap);
            }
        },
    });

    readonly selectedProteinEnrichmentProfileMap = remoteData({
        await: () => [this.proteinEnrichmentProfiles],
        invoke: () => {
            if (_.isEmpty(this._proteinEnrichmentProfileMap)) {
                const molecularProfilesbyStudyId = _.groupBy(
                    this.proteinEnrichmentProfiles.result!,
                    profile => profile.studyId
                );
                // Select only one molecular profile for each study
                return Promise.resolve(
                    _.mapValues(
                        molecularProfilesbyStudyId,
                        molecularProfiles => molecularProfiles[0]
                    )
                );
            } else {
                return Promise.resolve(this._proteinEnrichmentProfileMap);
            }
        },
    });

    @action
    public setMutationEnrichmentProfileMap(profileMap: {
        [studyId: string]: MolecularProfile;
    }) {
        this._mutationEnrichmentProfileMap = profileMap;
    }

    @action
    public setCopyNumberEnrichmentProfileMap(profileMap: {
        [studyId: string]: MolecularProfile;
    }) {
        this._copyNumberEnrichmentProfileMap = profileMap;
    }

    @action
    public setMRNAEnrichmentProfileMap(profiles: {
        [studyId: string]: MolecularProfile;
    }) {
        this._mRNAEnrichmentProfileMap = profiles;
    }

    @action
    public setProteinEnrichmentProfileMap(profileMap: {
        [studyId: string]: MolecularProfile;
    }) {
        this._proteinEnrichmentProfileMap = profileMap;
    }

    //
    public readonly mutationEnrichmentData = makeEnrichmentDataPromise({
        store: this.resultsViewStore,
        await: () => [
            this.selectedStudyMutationEnrichmentProfileMap,
            this.activeGroups,
        ],
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        getSelectedProfileMap: () =>
            this.selectedStudyMutationEnrichmentProfileMap.result!,
        fetchData: () => {
            let molecularProfiles = this
                .selectedStudyMutationEnrichmentProfileMap.result!;
            let studyMolecularProfileMap = _.keyBy(
                molecularProfiles,
                molecularProfile => molecularProfile.studyId
            );
            if (this.activeGroups.result!.length > 1) {
                let groups: MolecularProfileCasesGroupFilter[] = _.map(
                    this.activeGroups.result,
                    group => {
                        const molecularProfileCaseIdentifiers = _.flatMap(
                            group.studies,
                            study => {
                                return _.map(
                                    this.usePatientLevelEnrichments
                                        ? study.patients
                                        : study.samples,
                                    caseId => {
                                        return {
                                            caseId,
                                            molecularProfileId:
                                                studyMolecularProfileMap[
                                                    study.id
                                                ].molecularProfileId,
                                        };
                                    }
                                );
                            }
                        );
                        return {
                            name: group.nameWithOrdinal,
                            molecularProfileCaseIdentifiers,
                        };
                    }
                );

                return internalClient.fetchMutationEnrichmentsUsingPOST({
                    enrichmentType: this.usePatientLevelEnrichments
                        ? 'PATIENT'
                        : 'SAMPLE',
                    groups,
                });
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly copyNumberEnrichmentDataRequestGroups = remoteData({
        await: () => [
            this.selectedStudyCopyNumberEnrichmentProfileMap,
            this.activeGroups,
        ],
        invoke: async () => {
            let molecularProfile = this
                .selectedStudyCopyNumberEnrichmentProfileMap.result!;
            let groups: MolecularProfileCasesGroupFilter[] = _.map(
                this.activeGroups.result,
                group => {
                    const molecularProfileCaseIdentifiers = _.flatMap(
                        group.studies,
                        study => {
                            return _.map(
                                this.usePatientLevelEnrichments
                                    ? study.patients
                                    : study.samples,
                                caseId => {
                                    return {
                                        caseId,
                                        molecularProfileId:
                                            molecularProfile[study.id]
                                                .molecularProfileId,
                                    };
                                }
                            );
                        }
                    );
                    return {
                        name: group.nameWithOrdinal,
                        molecularProfileCaseIdentifiers,
                    };
                }
            );
            return groups;
        },
    });

    readonly copyNumberHomdelEnrichmentData = remoteData<
        AlterationEnrichment[]
    >({
        await: () => [this.copyNumberEnrichmentDataRequestGroups],
        invoke: () => {
            // assumes single study for now
            if (
                this.copyNumberEnrichmentDataRequestGroups.result &&
                this.copyNumberEnrichmentDataRequestGroups.result.length > 1
            ) {
                return this.getCopyNumberEnrichmentData(
                    this.copyNumberEnrichmentDataRequestGroups.result!,
                    'HOMDEL'
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly copyNumberAmpEnrichmentData = remoteData<AlterationEnrichment[]>({
        await: () => [this.copyNumberEnrichmentDataRequestGroups],
        invoke: () => {
            // assumes single study for now
            if (
                this.copyNumberEnrichmentDataRequestGroups.result &&
                this.copyNumberEnrichmentDataRequestGroups.result.length > 1
            ) {
                return this.getCopyNumberEnrichmentData(
                    this.copyNumberEnrichmentDataRequestGroups.result!,
                    'AMP'
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    public readonly copyNumberEnrichmentData = makeEnrichmentDataPromise({
        store: this.resultsViewStore,
        await: () => [
            this.copyNumberHomdelEnrichmentData,
            this.copyNumberAmpEnrichmentData,
            this.selectedStudyCopyNumberEnrichmentProfileMap,
        ],
        getSelectedProfileMap: () =>
            this.selectedStudyCopyNumberEnrichmentProfileMap.result!,
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        fetchData: () => {
            const ampData = this.copyNumberAmpEnrichmentData.result!.map(d => {
                (d as CopyNumberEnrichment).value = 2;
                return d as CopyNumberEnrichment;
            });
            const homdelData = this.copyNumberHomdelEnrichmentData.result!.map(
                d => {
                    (d as CopyNumberEnrichment).value = -2;
                    return d as CopyNumberEnrichment;
                }
            );
            return Promise.resolve(ampData.concat(homdelData));
        },
    });

    private getCopyNumberEnrichmentData(
        groups: MolecularProfileCasesGroupFilter[],
        copyNumberEventType: 'HOMDEL' | 'AMP'
    ): Promise<AlterationEnrichment[]> {
        return internalClient.fetchCopyNumberEnrichmentsUsingPOST({
            copyNumberEventType: copyNumberEventType,
            enrichmentType: this.usePatientLevelEnrichments
                ? 'PATIENT'
                : 'SAMPLE',
            groups,
        });
    }

    readonly mRNAEnrichmentData = makeEnrichmentDataPromise({
        store: this.resultsViewStore,
        await: () => [this.selectedmRNAEnrichmentProfileMap, this.activeGroups],
        getSelectedProfileMap: () =>
            this.selectedmRNAEnrichmentProfileMap.result!, // returns an empty array if the selected study doesn't have any mRNA profiles
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        fetchData: () => {
            let studyIds = Object.keys(
                this.selectedmRNAEnrichmentProfileMap.result!
            );
            // assumes single study for now
            if (studyIds.length === 1) {
                const molecularProfileId = this.selectedmRNAEnrichmentProfileMap
                    .result![studyIds[0]].molecularProfileId;
                const groups: MolecularProfileCasesGroupFilter[] = _.map(
                    this.activeGroups.result,
                    group => {
                        const molecularProfileCaseIdentifiers = _.flatMap(
                            group.studies,
                            study => {
                                return _.map(study.samples, sampleId => ({
                                    caseId: sampleId,
                                    molecularProfileId,
                                }));
                            }
                        );
                        return {
                            name: group.nameWithOrdinal,
                            molecularProfileCaseIdentifiers,
                        };
                    }
                );

                return internalClient.fetchExpressionEnrichmentsUsingPOST({
                    enrichmentType: 'SAMPLE',
                    groups,
                });
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly proteinEnrichmentData = makeEnrichmentDataPromise({
        store: this.resultsViewStore,
        await: () => [
            this.selectedProteinEnrichmentProfileMap,
            this.activeGroups,
        ],
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        getSelectedProfileMap: () =>
            this.selectedProteinEnrichmentProfileMap.result!, // returns an empty array if the selected study doesn't have any mRNA profiles
        fetchData: () => {
            let studyIds = Object.keys(
                this.selectedProteinEnrichmentProfileMap.result!
            );
            // assumes single study for now
            if (studyIds.length === 1) {
                const molecularProfileId = this
                    .selectedProteinEnrichmentProfileMap.result![studyIds[0]]
                    .molecularProfileId;
                const groups: MolecularProfileCasesGroupFilter[] = _.map(
                    this.activeGroups.result,
                    group => {
                        const molecularProfileCaseIdentifiers = _.flatMap(
                            group.studies,
                            study => {
                                return _.map(study.samples, sampleId => ({
                                    caseId: sampleId,
                                    molecularProfileId,
                                }));
                            }
                        );
                        return {
                            name: group.nameWithOrdinal,
                            molecularProfileCaseIdentifiers,
                        };
                    }
                );
                return internalClient.fetchExpressionEnrichmentsUsingPOST({
                    enrichmentType: 'SAMPLE',
                    groups,
                });
            } else {
                return Promise.resolve([]);
            }
        },
    });

    @computed get survivalTabShowable() {
        return (
            this.survivalClinicalDataExists.isComplete &&
            this.survivalClinicalDataExists.result
        );
    }

    @computed get showSurvivalTab() {
        return (
            this.survivalTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.SURVIVAL))
        );
    }

    @computed get survivalTabUnavailable() {
        // grey out if more than 10 active groups
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length > 10) ||
            !this.survivalTabShowable
        );
    }

    @computed get mutationsTabShowable() {
        return (
            this.mutationEnrichmentProfiles.isComplete &&
            this.mutationEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get showMutationsTab() {
        return (
            this.mutationsTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.MUTATIONS))
        );
    }

    @computed get mutationsTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            !this.mutationsTabShowable
        );
    }

    @computed get clinicalTabUnavailable() {
        // grey out if active groups is less than 2
        return (
            this.activeGroups.isComplete && this.activeGroups.result.length < 2
        );
    }

    @computed get copyNumberTabShowable() {
        return (
            this.copyNumberEnrichmentProfiles.isComplete &&
            this.copyNumberEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get showCopyNumberTab() {
        return (
            this.copyNumberTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.CNA))
        );
    }

    @computed get copyNumberUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            !this.copyNumberTabShowable
        );
    }

    @computed get mRNATabShowable() {
        return (
            this.mRNAEnrichmentProfiles.isComplete &&
            this.mRNAEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get showMRNATab() {
        return (
            this.mRNATabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.MRNA))
        );
    }

    @computed get mRNATabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            (this.activeStudyIds.isComplete &&
                this.activeStudyIds.result.length > 1) || //more than one active study
            !this.mRNATabShowable
        );
    }

    @computed get proteinTabShowable() {
        return (
            this.proteinEnrichmentProfiles.isComplete &&
            this.proteinEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get showProteinTab() {
        return (
            this.proteinTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.PROTEIN))
        );
    }

    @computed get proteinTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            (this.activeStudyIds.isComplete &&
                this.activeStudyIds.result.length > 1) || //more than one active study
            !this.proteinTabShowable
        );
    }

    public readonly sampleSet = remoteData({
        await: () => [this.samples],
        invoke: () => {
            const sampleSet = new ComplexKeyMap<Sample>();
            for (const sample of this.samples.result!) {
                sampleSet.set(
                    { studyId: sample.studyId, sampleId: sample.sampleId },
                    sample
                );
            }
            return Promise.resolve(sampleSet);
        },
    });

    readonly patientKeys = remoteData({
        await: () => [this.samples],
        invoke: () => {
            return Promise.resolve(
                _.uniq(this.samples.result!.map(s => s.uniquePatientKey))
            );
        },
    });

    public readonly patientToSamplesSet = remoteData({
        await: () => [this.samples],
        invoke: () => {
            const ret = new ComplexKeyGroupsMap<Sample>();
            for (const sample of this.samples.result!) {
                ret.add(
                    { studyId: sample.studyId, patientId: sample.patientId },
                    sample
                );
            }
            return Promise.resolve(ret);
        },
    });

    public readonly patientKeyToSamples = remoteData({
        await: () => [this.samples],
        invoke: () => {
            return Promise.resolve(
                _.groupBy(
                    this.samples.result!,
                    sample => sample.uniquePatientKey
                )
            );
        },
    });

    public readonly sampleKeyToSample = remoteData({
        await: () => [this.samples],
        invoke: () => {
            let sampleSet = _.reduce(
                this.samples.result!,
                (acc, sample) => {
                    acc[sample.uniqueSampleKey] = sample;
                    return acc;
                },
                {} as { [uniqueSampleKey: string]: Sample }
            );
            return Promise.resolve(sampleSet);
        },
    });

    public readonly patientsVennPartition = remoteData({
        await: () => [
            this._activeGroupsNotOverlapRemoved,
            this.patientToSamplesSet,
            this.activePatientKeysNotOverlapRemoved,
        ],
        invoke: () => {
            const patientToSamplesSet = this.patientToSamplesSet.result!;
            return Promise.resolve(partitionCasesByGroupMembership(
                this._activeGroupsNotOverlapRemoved.result!,
                group => getPatientIdentifiers([group]),
                patientIdentifier =>
                    patientToSamplesSet.get({
                        studyId: patientIdentifier.studyId,
                        patientId: patientIdentifier.patientId,
                    })![0].uniquePatientKey,
                this.activePatientKeysNotOverlapRemoved.result!
            ) as { key: { [uid: string]: boolean }; value: string[] }[]);
        },
    });

    readonly survivalClinicalDataExists = remoteData<boolean>({
        await: () => [this.activeSamplesNotOverlapRemoved],
        invoke: async () => {
            if (this.activeSamplesNotOverlapRemoved.result!.length === 0) {
                return false;
            }
            const filter: ClinicalDataMultiStudyFilter = {
                attributeIds: SURVIVAL_CHART_ATTRIBUTES,
                identifiers: this.activeSamplesNotOverlapRemoved.result!.map(
                    (s: any) => ({ entityId: s.patientId, studyId: s.studyId })
                ),
            };
            const count = await client
                .fetchClinicalDataUsingPOSTWithHttpInfo({
                    clinicalDataType: 'PATIENT',
                    clinicalDataMultiStudyFilter: filter,
                    projection: 'META',
                })
                .then(function(response: request.Response) {
                    return parseInt(response.header['total-count'], 10);
                });
            return count > 0;
        },
    });

    readonly survivalClinicalData = remoteData<ClinicalData[]>(
        {
            await: () => [this.activeSamplesNotOverlapRemoved],
            invoke: () => {
                if (this.activeSamplesNotOverlapRemoved.result!.length === 0) {
                    return Promise.resolve([]);
                }
                const filter: ClinicalDataMultiStudyFilter = {
                    attributeIds: SURVIVAL_CHART_ATTRIBUTES,
                    identifiers: this.activeSamplesNotOverlapRemoved.result!.map(
                        (s: any) => ({
                            entityId: s.patientId,
                            studyId: s.studyId,
                        })
                    ),
                };
                return client.fetchClinicalDataUsingPOST({
                    clinicalDataType: 'PATIENT',
                    clinicalDataMultiStudyFilter: filter,
                });
            },
        },
        []
    );

    readonly activeStudiesClinicalAttributes = remoteData<ClinicalAttribute[]>(
        {
            await: () => [this.activeStudyIds],
            invoke: () => {
                if (this.activeStudyIds.result!.length === 0) {
                    return Promise.resolve([]);
                }
                return client.fetchClinicalAttributesUsingPOST({
                    studyIds: this.activeStudyIds.result!,
                });
            },
        },
        []
    );

    readonly survivalClinicalDataGroupByUniquePatientKey = remoteData<{
        [key: string]: ClinicalData[];
    }>({
        await: () => [this.survivalClinicalData],
        invoke: async () => {
            return _.groupBy(
                this.survivalClinicalData.result,
                'uniquePatientKey'
            );
        },
    });

    readonly overallPatientSurvivals = remoteData<PatientSurvival[]>(
        {
            await: () => [
                this.survivalClinicalDataGroupByUniquePatientKey,
                this.activePatientKeysNotOverlapRemoved,
            ],
            invoke: async () => {
                return getPatientSurvivals(
                    this.survivalClinicalDataGroupByUniquePatientKey.result,
                    this.activePatientKeysNotOverlapRemoved.result!,
                    'OS_STATUS',
                    'OS_MONTHS',
                    s => s === 'DECEASED'
                );
            },
        },
        []
    );

    readonly diseaseFreePatientSurvivals = remoteData<PatientSurvival[]>(
        {
            await: () => [
                this.survivalClinicalDataGroupByUniquePatientKey,
                this.activePatientKeysNotOverlapRemoved,
            ],
            invoke: async () => {
                return getPatientSurvivals(
                    this.survivalClinicalDataGroupByUniquePatientKey.result,
                    this.activePatientKeysNotOverlapRemoved.result!,
                    'DFS_STATUS',
                    'DFS_MONTHS',
                    s => s === 'Recurred/Progressed' || s === 'Recurred'
                );
            },
        },
        []
    );

    readonly uidToGroup = remoteData({
        await: () => [this._originalGroups],
        invoke: () => {
            return Promise.resolve(
                _.keyBy(this._originalGroups.result!, group => group.uid)
            );
        },
    });

    public readonly clinicalDataEnrichments = remoteData(
        {
            await: () => [this.activeGroups],
            invoke: () => {
                if (this.clinicalTabUnavailable) {
                    return Promise.resolve([]);
                }
                let groups: Group[] = _.map(this.activeGroups.result, group => {
                    const sampleIdentifiers = [];
                    for (const studySpec of group.studies) {
                        const studyId = studySpec.id;
                        for (const sampleId of studySpec.samples) {
                            sampleIdentifiers.push({
                                studyId,
                                sampleId,
                            });
                        }
                    }
                    return {
                        name: group.nameWithOrdinal || group.uid,
                        sampleIdentifiers: sampleIdentifiers,
                    };
                });
                if (groups.length > 1) {
                    return internalClient.fetchClinicalEnrichmentsUsingPOST({
                        groupFilter: {
                            groups: groups,
                        },
                    });
                } else {
                    return Promise.resolve([]);
                }
            },
            onError: () => {
                // suppress failsafe error handler
            },
        },
        []
    );

    readonly clinicalDataEnrichmentsWithQValues = remoteData<
        ClinicalDataEnrichmentWithQ[]
    >(
        {
            await: () => [this.clinicalDataEnrichments],
            invoke: () => {
                const clinicalDataEnrichments = this.clinicalDataEnrichments
                    .result!;
                const sortedByPvalue = _.sortBy(
                    clinicalDataEnrichments,
                    c => c.pValue
                );
                const qValues = calculateQValues(
                    sortedByPvalue.map(c => c.pValue)
                );
                qValues.forEach((qValue, index) => {
                    (sortedByPvalue[
                        index
                    ] as ClinicalDataEnrichmentWithQ).qValue = qValue;
                });
                return Promise.resolve(
                    sortedByPvalue as ClinicalDataEnrichmentWithQ[]
                );
            },
            onError: () => {
                // suppress failsafe error handler
            },
        },
        []
    );

    readonly activeStudyIdToStudy = remoteData(
        {
            await: () => [this.studies, this.activeStudyIds],
            invoke: () =>
                Promise.resolve(
                    _.keyBy(
                        _.filter(this.studies.result, study =>
                            this.activeStudyIds.result!.includes(study.studyId)
                        ),
                        x => x.studyId
                    )
                ),
        },
        {}
    );

    readonly overallSurvivalDescriptions = remoteData({
        await: () => [
            this.activeStudiesClinicalAttributes,
            this.activeStudyIdToStudy,
        ],
        invoke: () => {
            const overallSurvivalClinicalAttributeId = 'OS_STATUS';
            const clinicalAttributeMap = _.groupBy(
                this.activeStudiesClinicalAttributes.result,
                'clinicalAttributeId'
            );
            const result: ISurvivalDescription[] = [];
            const studyIdToStudy: { [studyId: string]: CancerStudy } = this
                .activeStudyIdToStudy.result;
            if (
                clinicalAttributeMap &&
                clinicalAttributeMap[overallSurvivalClinicalAttributeId] &&
                clinicalAttributeMap[overallSurvivalClinicalAttributeId]
                    .length > 0
            ) {
                clinicalAttributeMap[
                    overallSurvivalClinicalAttributeId
                ].forEach(attr => {
                    result.push({
                        studyName: studyIdToStudy[attr.studyId].name,
                        description: attr.description,
                    } as ISurvivalDescription);
                });
                return Promise.resolve(result);
            }
            return Promise.resolve([]);
        },
    });

    readonly diseaseFreeSurvivalDescriptions = remoteData({
        await: () => [
            this.activeStudiesClinicalAttributes,
            this.activeStudyIdToStudy,
        ],
        invoke: () => {
            const diseaseFreeSurvivalClinicalAttributeId = 'DFS_STATUS';
            const clinicalAttributeMap = _.groupBy(
                this.activeStudiesClinicalAttributes.result,
                'clinicalAttributeId'
            );
            const result: ISurvivalDescription[] = [];
            const studyIdToStudy: { [studyId: string]: CancerStudy } = this
                .activeStudyIdToStudy.result;
            if (
                clinicalAttributeMap &&
                clinicalAttributeMap[diseaseFreeSurvivalClinicalAttributeId] &&
                clinicalAttributeMap[diseaseFreeSurvivalClinicalAttributeId]
                    .length > 0
            ) {
                clinicalAttributeMap[
                    diseaseFreeSurvivalClinicalAttributeId
                ].forEach(attr => {
                    result.push({
                        studyName: studyIdToStudy[attr.studyId].name,
                        description: attr.description,
                    } as ISurvivalDescription);
                });
                return Promise.resolve(result);
            }
            return Promise.resolve([]);
        },
    });
}
