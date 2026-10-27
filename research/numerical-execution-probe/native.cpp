#include "core.h"
#include "build_info.h"
#include "llama.h"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
std::string json(const std::string & s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
        else if (c < 0x20) throw std::runtime_error("control character in metadata");
        else out += char(c);
    }
    return out + '"';
}
int number(const std::string & s, int lo, int hi) {
    size_t used = 0; long v = std::stol(s, &used);
    if (used != s.size() || v < lo || v > hi) throw std::runtime_error("invalid integer option");
    return static_cast<int>(v);
}
std::vector<int32_t> parse_tokens(const std::string & s) {
    std::vector<int32_t> out; std::istringstream input(s); std::string item;
    if (s.empty() || s.back() == ',') throw std::runtime_error("invalid token list");
    while (std::getline(input, item, ',')) out.push_back(number(item, 0, std::numeric_limits<int32_t>::max()));
    if (out.size() < 2 || out.size() > 512) throw std::runtime_error("token count must be 2..512");
    return out;
}
struct Backend { Backend() { llama_backend_init(); } ~Backend() { llama_backend_free(); } };
using Model = std::unique_ptr<llama_model, decltype(&llama_model_free)>;
using Context = std::unique_ptr<llama_context, decltype(&llama_free)>;

class Session {
    Context ctx_;
    llama_memory_t memory_;
public:
    explicit Session(llama_model * model, int nctx, int batch, int ubatch, int threads)
        : ctx_(nullptr, llama_free), memory_(nullptr) {
        auto p = llama_context_default_params();
        p.n_ctx = nctx; p.n_batch = batch; p.n_ubatch = ubatch; p.n_seq_max = 1; p.n_rs_seq = 0;
        p.n_threads = threads; p.n_threads_batch = threads;
        p.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
        p.attention_type = LLAMA_ATTENTION_TYPE_CAUSAL; p.pooling_type = LLAMA_POOLING_TYPE_NONE;
        p.type_k = GGML_TYPE_F32; p.type_v = GGML_TYPE_F32;
        p.offload_kqv = false; p.op_offload = false; p.embeddings = false;
        p.kv_unified = false; p.samplers = nullptr; p.n_samplers = 0; p.ctx_other = nullptr;
        ctx_.reset(llama_init_from_model(model, p));
        if (!ctx_) throw std::runtime_error("context initialization failed");
        if (llama_n_ctx(ctx_.get()) != unsigned(nctx) || llama_n_batch(ctx_.get()) != unsigned(batch) ||
            llama_n_ubatch(ctx_.get()) != unsigned(ubatch) || llama_n_seq_max(ctx_.get()) != 1 ||
            llama_n_ctx_seq(ctx_.get()) != unsigned(nctx) || llama_n_rs_seq(ctx_.get()) != 0 ||
            llama_n_threads(ctx_.get()) != threads || llama_n_threads_batch(ctx_.get()) != threads)
            throw std::runtime_error("actual context settings differ from requested settings");
        memory_ = llama_get_memory(ctx_.get());
        if (!memory_ || llama_memory_seq_pos_min(memory_, 0) != -1 || llama_memory_seq_pos_max(memory_, 0) != -1)
            throw std::runtime_error("fresh context memory is unavailable or not empty");
    }
    bool submit(const e4eg::Batch & batch) {
        const size_t n = batch.size();
        std::vector<llama_token> tokens(n);
        std::vector<llama_pos> positions(n);
        std::vector<int32_t> nseq(n, 1);
        std::vector<llama_seq_id> seq(n, 0);
        std::vector<llama_seq_id *> seqptr(n);
        std::vector<int8_t> outputs(n);
        for (size_t i = 0; i < n; ++i) {
            tokens[i] = batch[i].token; positions[i] = batch[i].position;
            if (batch[i].sequence != 0) throw std::runtime_error("unsupported sequence id");
            seqptr[i] = &seq[i]; outputs[i] = batch[i].output ? 1 : 0;
        }
        llama_batch b{};
        b.n_tokens = static_cast<int32_t>(n); b.token = tokens.data(); b.pos = positions.data();
        b.n_seq_id = nseq.data(); b.seq_id = seqptr.data(); b.logits = outputs.data();
        int result = llama_decode(ctx_.get(), b);
        if (result != 0) throw std::runtime_error("llama_decode returned " + std::to_string(result));
        if (llama_memory_seq_pos_min(memory_, 0) != 0 || llama_memory_seq_pos_max(memory_, 0) != batch.back().position)
            throw std::runtime_error("unexpected sequence memory positions after decode");
        return true;
    }
    std::vector<float> read_logits(int index, size_t vocab) {
        const float * p = llama_get_logits_ith(ctx_.get(), index);
        if (!p) throw std::runtime_error("requested logits unavailable");
        return std::vector<float>(p, p + vocab);
    }
};
void write_vector(const std::string & path, const std::vector<float> & values) {
    static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559, "IEEE-754 float32 required");
    std::ofstream file(path, std::ios::binary | std::ios::out | std::ios::trunc);
    if (!file) throw std::runtime_error("cannot create vector file");
    for (float f : values) {
        uint32_t bits; std::memcpy(&bits, &f, 4);
        char bytes[4] = {char(bits), char(bits >> 8), char(bits >> 16), char(bits >> 24)};
        file.write(bytes, 4);
    }
    file.close();
    if (!file) throw std::runtime_error("cannot write complete vector file");
}
void usage() { std::cout << "e4eg-native: use the Python controller; real execution requires --execute-real-model and all explicit options.\n"; }
}
int main(int argc, char ** argv) {
    try {
        if (argc == 1) { usage(); return 0; }
        bool gate = false; std::map<std::string, std::string> opts;
        for (int i = 1; i < argc; ++i) {
            std::string key = argv[i];
            if (key == "--execute-real-model") { if (gate) throw std::runtime_error("duplicate execution flag"); gate = true; continue; }
            if (key != "--model" && key != "--path" && key != "--tokens" && key != "--output" &&
                key != "--ctx" && key != "--batch" && key != "--ubatch" && key != "--threads")
                throw std::runtime_error("unknown option: " + key);
            if (++i >= argc || !opts.emplace(key, argv[i]).second) throw std::runtime_error("missing or duplicate option");
        }
        // Nothing that touches a model or initializes a backend is reachable before this gate.
        if (!gate || opts.size() != 8 || opts["--model"].empty() || opts["--output"].empty())
            throw std::runtime_error("real model execution requires --execute-real-model and every explicit option");
        const auto tokens = parse_tokens(opts.at("--tokens"));
        if (opts.at("--path") != "A" && opts.at("--path") != "B") throw std::runtime_error("invalid path");
        const char path = opts.at("--path")[0];
        int nctx = number(opts.at("--ctx"), 32, 65536), batch = number(opts.at("--batch"), 2, 512);
        int ubatch = number(opts.at("--ubatch"), 2, 512), threads = number(opts.at("--threads"), 1, 16);
        if (nctx % 256 != 0 || batch > nctx || nctx < int(tokens.size()) || batch < int(tokens.size()) || ubatch < int(tokens.size()) || ubatch > batch)
            throw std::runtime_error("unsupported context or batch settings");
        const auto batches = e4eg::schedule(path, tokens);
        Backend backend;
        auto mp = llama_model_default_params(); mp.n_gpu_layers = 0;
        Model model(llama_model_load_from_file(opts.at("--model").c_str(), mp), llama_model_free);
        if (!model) throw std::runtime_error("model load failed");
        char split[32]{};
        int splitlen = llama_model_meta_val_str(model.get(), "split.count", split, sizeof(split));
        // One committed file must cover all weights. Split models need a different evidence contract.
        if (splitlen >= 0 && (splitlen >= int(sizeof(split)) || number(split, 0, 65535) > 1))
            throw std::runtime_error("split models are unsupported");
        char arch[128]{}; int archlen = llama_model_meta_val_str(model.get(), "general.architecture", arch, sizeof(arch));
        if (archlen != 5 || std::string(arch) != "llama" || llama_model_has_encoder(model.get()) ||
            !llama_model_has_decoder(model.get()) || llama_model_is_recurrent(model.get()) ||
            llama_model_is_hybrid(model.get()) || llama_model_is_diffusion(model.get()) || llama_model_n_swa(model.get()) != 0)
            throw std::runtime_error("unsupported architecture or memory semantics");
        if (nctx > llama_model_n_ctx_train(model.get())) throw std::runtime_error("context exceeds model training context");
        const auto * vocab = llama_model_get_vocab(model.get());
        int vocab_size = vocab ? llama_vocab_n_tokens(vocab) : 0;
        if (vocab_size < 2 || std::any_of(tokens.begin(), tokens.end(), [vocab_size](int t) { return t >= vocab_size; }))
            throw std::runtime_error("invalid vocabulary or token ID");
        Session session(model.get(), nctx, batch, ubatch, threads);
        auto logits = e4eg::evaluate(session, batches, static_cast<size_t>(vocab_size));
        write_vector(opts.at("--output"), logits);
        std::cout << "{\"revision\":" << json(E4EG_LLAMA_REV)
                  << ",\"compiler_c\":" << json(E4EG_C_COMPILER) << ",\"compiler_cxx\":" << json(E4EG_CXX_COMPILER)
                  << ",\"c_flags\":" << json(E4EG_C_FLAGS) << ",\"cxx_flags\":" << json(E4EG_CXX_FLAGS)
                  << ",\"cpu_build_options\":" << json(E4EG_CPU_INFO)
                  << ",\"architecture\":\"llama\",\"vocab_size\":" << vocab_size
                  << ",\"context\":" << nctx << ",\"batch\":" << batch << ",\"ubatch\":" << ubatch
                  << ",\"threads\":" << threads << ",\"initial_state\":\"fresh-empty\",\"schedule\":[";
        for (size_t i = 0; i < batches.size(); ++i) {
            if (i) std::cout << ',';
            const auto & b = batches[i];
            std::cout << "{\"start\":" << b.front().position << ",\"count\":" << b.size()
                      << ",\"sequence_id\":0,\"output_index\":" << (b.back().output ? int(b.size()) - 1 : -1) << '}';
        }
        std::cout << "]}\n";
        return 0;
    } catch (const std::exception & e) { std::cerr << "e4eg-native: " << e.what() << '\n'; return 1; }
}
