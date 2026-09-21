import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";

type CommandOutputProps = { environmentId: EnvironmentId; threadId: ThreadId; activityId: string };

export function CommandOutput(
  props: CommandOutputProps & { fallback: string; command: string; preview: string },
) {
  const supported = useAtomValue(
    serverEnvironment.configValueAtom(props.environmentId),
    (config) => config?.environment.capabilities.commandOutput === true,
  );
  if (!supported)
    return (
      <Text selectable className="font-mono text-2xs text-foreground-muted">
        {props.fallback}
      </Text>
    );
  return (
    <View>
      <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
        {props.command}
        {"\n"}
      </Text>
      <CommandOutputPage key={props.activityId} {...props} offset={0} />
    </View>
  );
}

function CommandOutputPage(props: CommandOutputProps & { offset: number; preview: string }) {
  const query = orchestrationEnvironment.commandOutput({
    environmentId: props.environmentId,
    input: { threadId: props.threadId, activityId: props.activityId, offset: props.offset },
  });
  const result = useAtomValue(query);
  const retry = useAtomRefresh(query);
  const [showMore, setShowMore] = useState(false);
  if (result._tag === "Failure")
    return (
      <View>
        <Text>Could not load output.</Text>
        <Pressable accessibilityRole="button" onPress={retry}>
          <Text>Retry</Text>
        </Pressable>
      </View>
    );
  if (result._tag !== "Success") return <Text>Loading output…</Text>;
  return (
    <View>
      <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
        {result.value.text || (props.offset === 0 ? props.preview || "No output recorded." : "")}
      </Text>
      {result.value.nextOffset !== null &&
        (showMore ? (
          <CommandOutputPage {...props} offset={result.value.nextOffset} />
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setShowMore(true)}>
            <Text className="py-2 underline">Load more output</Text>
          </Pressable>
        ))}
    </View>
  );
}
