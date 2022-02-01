import { useMemo, useState } from "react";
import { useIntl } from "react-intl";
import * as yup from "yup";
import { setIn } from "formik";

import {
  AirbyteStreamConfiguration,
  DestinationSyncMode,
  SyncMode,
  SyncSchema,
  SyncSchemaStream,
} from "core/domain/catalog";
import { ValuesProps } from "hooks/services/useConnectionHook";
import {
  Normalization,
  NormalizationType,
  Operation,
  OperatorType,
  Transformation,
} from "core/domain/connection/operation";
import { DropDownRow } from "components";
import FrequencyConfig from "config/FrequencyConfig.json";
import { Connection, ScheduleProperties } from "core/resources/Connection";
import { ConnectionNamespaceDefinition } from "core/domain/connection";
import { SOURCE_NAMESPACE_TAG } from "core/domain/connector/source";
import useWorkspace from "hooks/services/useWorkspace";
import { DestinationDefinitionSpecification } from "core/domain/connector";

type FormikConnectionFormValues = {
  schedule?: ScheduleProperties | null;
  prefix: string;
  syncCatalog: SyncSchema;
  namespaceDefinition: ConnectionNamespaceDefinition;
  namespaceFormat: string;
  transformations?: Transformation[];
  normalization?: NormalizationType;
};

type ConnectionFormValues = ValuesProps;

const SUPPORTED_MODES: [SyncMode, DestinationSyncMode][] = [
  [SyncMode.FullRefresh, DestinationSyncMode.Overwrite],
  [SyncMode.FullRefresh, DestinationSyncMode.Append],
  [SyncMode.Incremental, DestinationSyncMode.Append],
  [SyncMode.Incremental, DestinationSyncMode.Dedupted],
];

function useDefaultTransformation(): Transformation {
  const { workspace } = useWorkspace();

  return {
    name: "My dbt transformations",
    workspaceId: workspace.workspaceId,
    operatorConfiguration: {
      operatorType: OperatorType.Dbt,
      dbt: {
        dockerImage: "fishtownanalytics/dbt:0.19.1",
        dbtArguments: "run",
      },
    },
  };
}

const connectionValidationSchema = yup
  .object({
    schedule: yup
      .object({
        units: yup.number().required("form.empty.error"),
        timeUnit: yup.string().required("form.empty.error"),
      })
      .nullable()
      .defined("form.empty.error"),
    namespaceDefinition: yup
      .string()
      .oneOf([
        ConnectionNamespaceDefinition.Source,
        ConnectionNamespaceDefinition.Destination,
        ConnectionNamespaceDefinition.CustomFormat,
      ])
      .required("form.empty.error"),
    namespaceFormat: yup.string().when("namespaceDefinition", {
      is: ConnectionNamespaceDefinition.CustomFormat,
      then: yup.string().required("form.empty.error"),
    }),
    prefix: yup.string(),
    syncCatalog: yup.object({
      streams: yup.array().of(
        yup.object({
          id: yup
            .string()
            // This is required to get rid of id fields we are using to detect stream for edition
            .strip(true),
          stream: yup.object(),
          // @ts-ignore
          config: yup.object().test({
            name: "connectionSchema.config.validator",
            // eslint-disable-next-line no-template-curly-in-string
            message: "${path} is wrong",
            test: function (value: AirbyteStreamConfiguration) {
              if (!value.selected) {
                return true;
              }
              if (DestinationSyncMode.Dedupted === value.destinationSyncMode) {
                if (value.primaryKey.length === 0) {
                  return this.createError({
                    message: "connectionForm.primaryKey.required",
                    path: `schema.streams[${this.parent.id}].config.primaryKey`,
                  });
                }
              }

              if (SyncMode.Incremental === value.syncMode) {
                if (
                  !this.parent.stream.sourceDefinedCursor &&
                  value.cursorField.length === 0
                ) {
                  return this.createError({
                    message: "connectionForm.cursorField.required",
                    path: `schema.streams[${this.parent.id}].config.cursorField`,
                  });
                }
              }
              return true;
            },
          }),
        })
      ),
    }),
  })
  .noUnknown();

/**
 * Returns {@link Operation}[]
 *
 * Maps UI representation of Transformation and Normalization
 * into API's {@link Operation} representation.
 *
 * Always puts normalization as first operation
 * @param values
 * @param initialOperations
 * @param workspaceId
 */
function mapFormPropsToOperation(
  values: {
    transformations?: Transformation[];
    normalization?: NormalizationType;
  },
  initialOperations: Operation[] = [],
  workspaceId: string
): Operation[] {
  const newOperations: Operation[] = [];

  if (values.normalization) {
    if (values.normalization !== NormalizationType.RAW) {
      const normalizationOperation = initialOperations.find(
        (op) =>
          op.operatorConfiguration.operatorType === OperatorType.Normalization
      );

      if (normalizationOperation) {
        newOperations.push(normalizationOperation);
      } else {
        newOperations.push({
          name: "Normalization",
          workspaceId,
          operatorConfiguration: {
            operatorType: OperatorType.Normalization,
            normalization: {
              option: values.normalization,
            },
          },
        });
      }
    }
  }

  if (values.transformations) {
    newOperations.push(...values.transformations);
  }

  return newOperations;
}

function getDefaultCursorField(streamNode: SyncSchemaStream): string[] {
  if (streamNode.stream.defaultCursorField.length) {
    return streamNode.stream.defaultCursorField;
  }
  return streamNode.config.cursorField;
}

const useInitialSchema = (schema: SyncSchema): SyncSchema =>
  useMemo<SyncSchema>(
    () => ({
      streams: schema.streams.map<SyncSchemaStream>((apiNode, id) => {
        const nodeWithId: SyncSchemaStream = { ...apiNode, id: id.toString() };

        // If the value in supportedSyncModes is empty assume the only supported sync mode is FULL_REFRESH.
        // Otherwise, it supports whatever sync modes are present.
        const streamNode = nodeWithId.stream.supportedSyncModes?.length
          ? nodeWithId
          : setIn(nodeWithId, "stream.supportedSyncModes", [
              SyncMode.FullRefresh,
            ]);

        // If syncMode isn't null - don't change item
        if (streamNode.config.syncMode) {
          return streamNode;
        }

        const updateStreamConfig = (
          config: Partial<AirbyteStreamConfiguration>
        ): SyncSchemaStream => ({
          ...streamNode,
          config: { ...streamNode.config, ...config },
        });

        const supportedSyncModes = streamNode.stream.supportedSyncModes;

        // Prefer INCREMENTAL sync mode over other sync modes
        if (supportedSyncModes.includes(SyncMode.Incremental)) {
          return updateStreamConfig({
            cursorField: streamNode.config.cursorField.length
              ? streamNode.config.cursorField
              : getDefaultCursorField(streamNode),
            syncMode: SyncMode.Incremental,
          });
        }

        // If source don't support INCREMENTAL and FULL_REFRESH - set first value from supportedSyncModes list
        return updateStreamConfig({
          syncMode: streamNode.stream.supportedSyncModes[0],
        });
      }),
    }),
    [schema.streams]
  );

const getInitialTransformations = (operations: Operation[]): Transformation[] =>
  (operations.filter(
    (op) => op.operatorConfiguration.operatorType === OperatorType.Dbt
  ) as Transformation[]) ?? [];

const getInitialNormalization = (
  operations: Operation[],
  isEditMode?: boolean
): NormalizationType => {
  let initialNormalization = (operations.find(
    (op) => op.operatorConfiguration.operatorType === OperatorType.Normalization
  ) as Normalization)?.operatorConfiguration?.normalization?.option;

  // If no normalization was selected for already present normalization -> select Raw one
  if (!initialNormalization && isEditMode) {
    initialNormalization = NormalizationType.RAW;
  }

  return initialNormalization ?? NormalizationType.BASIC;
};

const useInitialValues = (
  connection:
    | Connection
    | (Partial<Connection> &
        Pick<Connection, "syncCatalog" | "source" | "destination">),
  destDefinition: DestinationDefinitionSpecification,
  isEditMode?: boolean
): FormikConnectionFormValues => {
  const initialSchema = useInitialSchema(connection.syncCatalog);

  return useMemo(() => {
    const initialValues: FormikConnectionFormValues = {
      syncCatalog: initialSchema,
      schedule: connection.schedule,
      prefix: connection.prefix || "",
      namespaceDefinition:
        connection.namespaceDefinition ?? ConnectionNamespaceDefinition.Source,
      namespaceFormat: connection.namespaceFormat ?? SOURCE_NAMESPACE_TAG,
    };

    const operations = connection.operations || [];

    if (destDefinition.supportsDbt) {
      initialValues.transformations = getInitialTransformations(operations);
    }

    if (destDefinition.supportsNormalization) {
      initialValues.normalization = getInitialNormalization(
        operations,
        isEditMode
      );
    }

    return initialValues;
  }, [initialSchema, connection, isEditMode, destDefinition]);
};

const useFrequencyDropdownData = (): DropDownRow.IDataItem[] => {
  const { formatMessage } = useIntl();

  return useMemo(
    () =>
      FrequencyConfig.map((item) => ({
        value: item.config,
        label:
          item.config === null
            ? item.text
            : formatMessage(
                {
                  id: "form.every",
                },
                {
                  value: item.simpleText || item.text,
                }
              ),
      })),
    [formatMessage]
  );
};

const useBulkEdit = (
  nodes: SyncSchemaStream[],
  update: (streams: SyncSchemaStream[]) => void
) => {
  const [selectedBatchNodes] = useState<string[]>([]);
  const [isActive, toggleActiveMode] = useState(false);
  const [options, setOptions] = useState<Partial<AirbyteStreamConfiguration>>(
    {}
  );

  const onApply = () => {
    const updatedConfig = nodes
      .filter((node) => selectedBatchNodes.includes(node.id))
      .map((node) => setIn(node, "config", { ...node.config, ...options }));

    update(updatedConfig);
  };

  return {
    isActive,
    toggleActiveMode,
    onChangeOption: setOptions,
    options,
    onApply,
    onCancel: () => console.log("Define"),
  };
};

export type { ConnectionFormValues, FormikConnectionFormValues };
export {
  connectionValidationSchema,
  useInitialValues,
  useBulkEdit,
  useFrequencyDropdownData,
  mapFormPropsToOperation,
  SUPPORTED_MODES,
  useDefaultTransformation,
  getInitialNormalization,
  getInitialTransformations,
};
