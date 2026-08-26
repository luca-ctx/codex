use super::*;

#[test]
fn enabled_filter_suppresses_only_registered_threads() {
    let filter = SubagentNotificationFilter::enabled_for_test();
    let child_thread_id = ThreadId::new();
    let parent_thread_id = ThreadId::new();

    filter.register(child_thread_id);

    assert!(filter.should_suppress(child_thread_id));
    assert!(!filter.should_suppress(parent_thread_id));

    filter.unregister(child_thread_id);
    assert!(!filter.should_suppress(child_thread_id));
}

#[test]
fn common_truthy_environment_values_enable_filtering() {
    for value in ["1", "true", "TRUE", "yes", "on"] {
        assert!(env_value_is_enabled(Some(value)));
    }
    for value in ["", "0", "false", "no", "off", "unexpected"] {
        assert!(!env_value_is_enabled(Some(value)));
    }
    let missing_value: Option<&str> = None;
    assert!(!env_value_is_enabled(missing_value));
}
