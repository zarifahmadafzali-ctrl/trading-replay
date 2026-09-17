// Trading Replay desktop shell — TypeScript owns all trading logic.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    trading_replay_lib::run()
}
