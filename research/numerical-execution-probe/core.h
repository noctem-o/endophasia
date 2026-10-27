#pragma once
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace e4eg {
struct Item { int32_t token, position, sequence; bool output; };
using Batch = std::vector<Item>;

inline std::vector<Batch> schedule(char path, const std::vector<int32_t> & tokens) {
    if (tokens.size() < 2 || tokens.size() > 512 || (path != 'A' && path != 'B'))
        throw std::runtime_error("invalid path or token count");
    std::vector<Batch> batches(path == 'A' ? 1 : 2);
    for (size_t i = 0; i < tokens.size(); ++i) {
        if (tokens[i] < 0) throw std::runtime_error("negative token ID");
        const size_t b = path == 'B' && i == tokens.size() - 1 ? 1 : 0;
        batches[b].push_back({tokens[i], static_cast<int32_t>(i), 0, i == tokens.size() - 1});
    }
    return batches;
}

// This is shared by the native adapter and the offline fake, including selection
// of the last submitted batch's explicitly flagged final token.
template <class Session>
std::vector<float> evaluate(Session & session, const std::vector<Batch> & batches, size_t vocab) {
    if (vocab < 2 || batches.empty()) throw std::runtime_error("invalid vocabulary or schedule");
    for (const auto & batch : batches) {
        if (batch.empty() || !session.submit(batch)) throw std::runtime_error("batch evaluation failed");
    }
    const auto & last = batches.back();
    if (!last.back().output) throw std::runtime_error("final output not requested");
    auto result = session.read_logits(static_cast<int32_t>(last.size() - 1), vocab);
    if (result.size() != vocab) throw std::runtime_error("logit vector unavailable or wrong size");
    return result; // copied before the session or output buffer can be destroyed
}
}
