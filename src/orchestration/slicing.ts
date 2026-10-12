// src/orchestration/slicing.ts
import { AssetDescriptor, InstantiatedDAGNode, UnifiedProtocolEnvelope } from "./types";

export interface NodeExecutionContext {
  claimed_assets: AssetDescriptor[];
  upstream_text: string;
  injected_prompt: string;
  is_head_masked: boolean;
  is_downstream: boolean;
  parent_role_name?: string;
  custom_prompt?: string;
  compensation_prompt?: string;
  target_language: string;
  output_style: string;
}

/**
 * Step 4: Envelope Slicing & State Machine Execution ("不贪吃规则" 与 指令遮蔽法则)
 * 
 * Rules:
 * - Head Node in multi-node DAG (in_degree === 0 && out_degree > 0): 
 *   Claims matching unconsumed assets. Strictly MASKS user instruction payload (is_head_masked = true)
 *   so perception is purely driven by role requisition prompt without downstream contamination.
 * - Single-Node DAG (in_degree === 0 && out_degree === 0):
 *   Both head and tail, receives user instruction payload directly.
 * - Intermediate Node (in_degree > 0 && out_degree > 0): 
 *   ONLY receives parent node output $out_parent (strictly forbidden from touching main envelope).
 * - Tail Node (out_degree === 0): 
 *   Receives parent output + remaining unconsumed matching assets + user_prompt + constraint_context.
 * - Downstream Nodes (in_degree > 0):
 *   System Prompt anchoring injects guidance to trust <Upstream_Artifact> and ignore physical viewing demands.
 */
export function sliceEnvelopeForNode(
  node: InstantiatedDAGNode,
  envelope: UnifiedProtocolEnvelope,
  parentOutput?: string,
  parentRoleName?: string
): NodeExecutionContext {
  const claimedAssets: AssetDescriptor[] = [];
  const modelModalities = new Set(node.selected_model.modalities);

  // 1. Data Claiming Responsibility (Head Node: in_degree === 0)
  if (node.role.in_degree === 0) {
    for (const asset of envelope.assets_manifest) {
      if (!asset.consumed && modelModalities.has(asset.modality)) {
        asset.consumed = true;
        claimedAssets.push(asset);
      }
    }
  }

  // 2. Intermediate & Tail Nodes: Upstream text from parent
  const upstreamText = parentOutput || '';
  const isDownstream = node.role.in_degree > 0;

  // 3. Instruction & Constraints Injection Responsibility
  // Head Node in multi-node DAG (in=0 && out>0): Strictly MASK user prompt!
  // Single-node DAG (in=0 && out=0): Receives user prompt.
  // Downstream Node (in>0): Receives user prompt (anchored by System Prompt guidance).
  const isHeadMasked = node.role.in_degree === 0 && node.role.out_degree > 0;
  const injectedPrompt = isHeadMasked ? '' : (envelope.instruction_payload || '');

  if (node.role.out_degree === 0) {
    // Tail node also claims any remaining unconsumed assets that this model can accept
    for (const asset of envelope.assets_manifest) {
      if (!asset.consumed && modelModalities.has(asset.modality)) {
        asset.consumed = true;
        claimedAssets.push(asset);
      }
    }
  }

  return {
    claimed_assets: claimedAssets,
    upstream_text: upstreamText,
    injected_prompt: injectedPrompt,
    is_head_masked: isHeadMasked,
    is_downstream: isDownstream,
    parent_role_name: parentRoleName,
    custom_prompt: node.custom_prompt,
    compensation_prompt: node.compensation_prompt,
    target_language: envelope.constraint_context.target_language,
    output_style: envelope.constraint_context.output_style
  };
}
