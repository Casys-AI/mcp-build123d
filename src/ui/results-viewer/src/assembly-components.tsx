/// <reference lib="dom" />

import { defineComponentRegistry } from "@casys/mcp-view-components";
import {
  Badge,
  DataTable,
  definePreactComponent,
  ElementIdent,
  ElementSection,
  FocusedView,
  KeyValueList,
  MetricGrid,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
  SemanticElement,
} from "@casys/mcp-view-components/preact";
import { ViewerBrandFooter } from "../../shared/branding.tsx";
import type {
  AssemblyIntegrityOccurrence,
  AssemblyIntegrityPair,
} from "./assembly-contract.ts";
import { assemblyMessages } from "./assembly-locale.ts";
import {
  type AssemblyComponentData,
  assemblyIdentity,
  assemblyMetrics,
  type AssemblyOccurrenceDisplay,
  assemblyOccurrenceDisplays,
  assemblyOccurrenceRows,
  assemblyPairRows,
  assemblySourceFacts,
  assemblyTopologyFacts,
  assemblyTransformText,
  BUILD123D_ASSEMBLY_COMPONENT_KEYS,
  BUILD123D_ASSEMBLY_DEFAULT_SURFACE,
  factText,
} from "./assembly-model.ts";

type Props = PreactSurfaceComponentProps<AssemblyComponentData>;

/** One provider-factual datasheet; every unknown state keeps its literal reason. */
const AssemblyDatasheet = ({ data, context }: Props) => {
  const { observation } = data;
  const locale = context.hostContext.locale;
  const t = assemblyMessages(locale);
  const identity = assemblyIdentity(observation, locale);
  const occurrences = assemblyOccurrenceRows(observation);
  const pairs = assemblyPairRows(observation);
  const occurrenceDisplays = assemblyOccurrenceDisplays(
    observation,
    data.displayNames,
    locale,
  );
  return (
    <>
      <FocusedView
        label={identity.label}
        hostContext={context.hostContext}
        status={
          <SemanticElement
            reference={{
              domain: "build123d",
              kind: observation.kind,
              id: observation.inputArtifact.sha256,
              basisFingerprint: observation.inputArtifact.sha256,
            }}
            density="row"
            ident={
              <ElementIdent
                marker={<Badge tone={identity.tone}>{identity.marker}</Badge>}
                label={identity.label}
                detail={
                  <span style={{ overflowWrap: "anywhere" }}>
                    {identity.detail}
                  </span>
                }
              />
            }
          />
        }
        primary={
          <>
            <MetricGrid items={assemblyMetrics(observation, locale)} />
            <ElementSection title={t("pairs")}>
              {observation.pairs.status === "observed"
                ? (
                  <PairTable
                    rows={pairs}
                    displays={occurrenceDisplays}
                    locale={locale}
                  />
                )
                : (
                  <KeyValueList
                    items={[{
                      id: "pairs-status",
                      label: t("pairs"),
                      value: factText<readonly AssemblyIntegrityPair[]>(
                        observation.pairs,
                        (rows) => String(rows.length),
                      ),
                    }]}
                  />
                )}
            </ElementSection>
          </>
        }
        detailsLabel={t("details")}
        details={
          <>
            <ElementSection title={t("occurrences")}>
              {observation.occurrences.status === "observed"
                ? (
                  <OccurrenceTable
                    rows={occurrences}
                    displays={occurrenceDisplays}
                    locale={locale}
                  />
                )
                : (
                  <KeyValueList
                    items={[{
                      id: "occurrences-status",
                      label: t("occurrences"),
                      value: factText<readonly AssemblyIntegrityOccurrence[]>(
                        observation.occurrences,
                        (rows) => String(rows.length),
                      ),
                    }]}
                  />
                )}
            </ElementSection>
            <ElementSection title={t("topology")}>
              <KeyValueList
                items={assemblyTopologyFacts(observation, locale)}
              />
            </ElementSection>
            <ElementSection title={t("source")}>
              <KeyValueList items={assemblySourceFacts(observation, locale)} />
            </ElementSection>
          </>
        }
      />
      <ViewerBrandFooter />
    </>
  );
};

const PairTable = (
  { rows, displays, locale }: {
    readonly rows: readonly AssemblyIntegrityPair[];
    readonly displays: ReadonlyMap<string, AssemblyOccurrenceDisplay>;
    readonly locale?: string;
  },
) => {
  const t = assemblyMessages(locale);
  return (
    <DataTable
      label={t("pairs")}
      rows={rows}
      rowKey={(row) => JSON.stringify([row.firstLabel, row.secondLabel])}
      emptyLabel={t("noPairs")}
      columns={[
        {
          id: "first",
          label: t("first"),
          render: (row) => (
            <OccurrenceName
              display={displays.get(row.firstLabel)}
              fallback={row.firstLabel}
            />
          ),
        },
        {
          id: "second",
          label: t("second"),
          render: (row) => (
            <OccurrenceName
              display={displays.get(row.secondLabel)}
              fallback={row.secondLabel}
            />
          ),
        },
        {
          id: "distance",
          label: `${t("minimumDistance")} (mm)`,
          align: "right",
          render: (row) => factText(row.minimumDistanceMm),
        },
        {
          id: "intersection",
          label: `${t("intersectionVolume")} (mm³)`,
          align: "right",
          render: (row) => factText(row.intersectionVolumeMm3),
        },
        {
          id: "contact",
          label: t("contact"),
          render: (row) => <Badge>{factText(row.contact)}</Badge>,
        },
      ]}
    />
  );
};

const OccurrenceTable = (
  { rows, displays, locale }: {
    readonly rows: readonly AssemblyIntegrityOccurrence[];
    readonly displays: ReadonlyMap<string, AssemblyOccurrenceDisplay>;
    readonly locale?: string;
  },
) => {
  const t = assemblyMessages(locale);
  return (
    <DataTable
      label={t("occurrences")}
      rows={rows}
      rowKey={(row) => row.label}
      emptyLabel={t("noOccurrences")}
      columns={[
        {
          id: "label",
          label: t("label"),
          render: (row) => (
            <OccurrenceName
              display={displays.get(row.label)}
              fallback={row.label}
            />
          ),
        },
        {
          id: "technical-id",
          label: t("technicalId"),
          render: (row) => {
            const technicalId = displays.get(row.label)?.technicalId;
            return technicalId
              ? (
                <code
                  style={{
                    display: "block",
                    maxWidth: "22rem",
                    whiteSpace: "normal",
                    overflowWrap: "anywhere",
                  }}
                >
                  {technicalId}
                </code>
              )
              : "—";
          },
        },
        {
          id: "transform",
          label: t("transform"),
          render: (row) => (
            <code
              style={{
                display: "block",
                maxWidth: "28rem",
                whiteSpace: "normal",
                overflowWrap: "anywhere",
              }}
            >
              {assemblyTransformText(row.transform)}
            </code>
          ),
        },
      ]}
    />
  );
};

const OccurrenceName = (
  { display, fallback }: {
    readonly display?: AssemblyOccurrenceDisplay;
    readonly fallback: string;
  },
) => (
  <span title={display?.technicalId ?? fallback}>
    {display?.name ?? fallback}
  </span>
);

export const BUILD123D_ASSEMBLY_COMPONENT_REGISTRY = defineComponentRegistry<
  AssemblyComponentData,
  PreactSurfaceContext<AssemblyComponentData>
>({
  components: {
    [BUILD123D_ASSEMBLY_COMPONENT_KEYS.datasheet]: definePreactComponent(
      {
        title: "Assembly datasheet",
        description:
          "Direct STEP assembly observations, literal fact states, occurrence pairs, topology and source.",
      },
      AssemblyDatasheet,
    ),
  },
  defaultSurface: BUILD123D_ASSEMBLY_DEFAULT_SURFACE,
});
