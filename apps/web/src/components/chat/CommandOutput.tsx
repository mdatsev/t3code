import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { useServerConfigs } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";

export function CommandOutput(props: {
  threadRef: ScopedThreadRef;
  activityId: string;
  fallback: string;
  command: string;
  preview: string;
  fileChange?: boolean;
}) {
  const configs = useServerConfigs();
  const capability = props.fileChange ? "fileChangeOutput" : "commandOutput";
  if (configs.get(props.threadRef.environmentId)?.environment.capabilities[capability] !== true) {
    return (
      <>
        {props.fileChange
          ? `${props.fallback}\nEdit contents aren't available from this server.`
          : props.fallback}
      </>
    );
  }
  return (
    <>
      {props.command && `${props.command}\n\n`}
      <CommandOutputPage key={props.activityId} {...props} offset={0} />
    </>
  );
}

function CommandOutputPage(props: {
  threadRef: ScopedThreadRef;
  activityId: string;
  offset: number;
  preview: string;
  fileChange?: boolean;
}) {
  const query = orchestrationEnvironment.commandOutput({
    environmentId: props.threadRef.environmentId,
    input: {
      threadId: props.threadRef.threadId,
      activityId: props.activityId,
      offset: props.offset,
    },
  });
  const result = useAtomValue(query);
  const retry = useAtomRefresh(query);
  const [showMore, setShowMore] = useState(false);
  if (result._tag === "Failure") {
    return (
      <span className="block">
        {props.offset === 0 && props.preview && `${props.preview}\n`}
        Could not load output.{" "}
        <button type="button" className="underline" onClick={retry}>
          Retry
        </button>
      </span>
    );
  }
  if (result._tag !== "Success") return <span className="block">Loading output…</span>;
  return (
    <>
      {result.value.text ||
        (props.offset === 0
          ? props.fileChange
            ? "No edit contents were recorded."
            : props.preview || "No output recorded."
          : "")}
      {result.value.nextOffset !== null &&
        (showMore ? (
          <CommandOutputPage {...props} offset={result.value.nextOffset} />
        ) : (
          <button type="button" className="mt-2 block underline" onClick={() => setShowMore(true)}>
            Load more output
          </button>
        ))}
    </>
  );
}
