from xunlei_zhiqu_runtime.models import PlanItem, ResourceJobCreateRequest


def compile_confirmed_request(payload: ResourceJobCreateRequest) -> ResourceJobCreateRequest:
    """Compile the user's explicit item confirmation for deterministic execution.

    ResourcePlan remains an AI analysis artifact at the API boundary. The current
    in-memory Stage-B job store consumes the compiled execution view returned here.
    """
    if not payload.confirmed_item_ids:
        raise ValueError("至少需要确认一个 ResourcePlan item")
    if len(payload.confirmed_item_ids) != len(set(payload.confirmed_item_ids)):
        raise ValueError("confirmed_item_ids 不能重复")

    groups = (
        payload.plan.selected,
        payload.plan.alternatives,
        payload.plan.uncertainties,
        payload.plan.excluded,
    )
    item_index: dict[str, PlanItem] = {}
    for item in (item for group in groups for item in group):
        if item.item_id in item_index:
            raise ValueError(f"ResourcePlan item_id 重复: {item.item_id}")
        item_index[item.item_id] = item

    unknown = [item_id for item_id in payload.confirmed_item_ids if item_id not in item_index]
    if unknown:
        raise ValueError(f"confirmed_item_ids 包含未知 item: {unknown}")

    confirmed = [item_index[item_id] for item_id in payload.confirmed_item_ids]
    confirmed_set = set(payload.confirmed_item_ids)
    unconfirmed_ai_selected = [item for item in payload.plan.selected if item.item_id not in confirmed_set]
    remaining_alternatives = [item for item in payload.plan.alternatives if item.item_id not in confirmed_set]
    remaining_uncertainties = [item for item in payload.plan.uncertainties if item.item_id not in confirmed_set]
    remaining_excluded = [item for item in payload.plan.excluded if item.item_id not in confirmed_set]

    execution_plan = payload.plan.model_copy(
        update={
            "selected": confirmed,
            "alternatives": unconfirmed_ai_selected + remaining_alternatives,
            "uncertainties": remaining_uncertainties,
            "excluded": remaining_excluded,
        }
    )
    return payload.model_copy(update={"plan": execution_plan})
