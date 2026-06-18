# Data

Data to use for the `/stats` endpoint

```json
 
 *         "model_memory_used": 4747803200,
        "model_memory_max": 28927143283,
        "memory_pressure": {
            "enabled": true,
            "current_bytes": 4747803200,
            "soft_bytes": 24588071790,
            "hard_bytes": 27480786118,
            "current_formatted": "4.4GB",
            "soft_formatted": "22.9GB",
            "hard_formatted": "25.6GB",
            "pressure_level": "ok"
        },


 *         "models": [
            {
                "id": "Qwen3.6-35B-A3B-MLX-oQ4-FP16",
                "estimated_size": 21393481580,
                "estimated_size_formatted": "19.92GB",
                "actual_size": 0,
                "actual_size_formatted": null,
                "pinned": false,
                "is_loading": true,
                "loading_elapsed_seconds": 5.447678167000049,
                "loading_estimated_seconds": 31.872987946158155,
                "loading_remaining_seconds_estimate": 26.425309779158106,
                "active_requests": 0,
                "waiting_requests": 0,
                "waiting": [],
                "activities": [],
                "prefilling": [],
                "generating": [],
                "idle_seconds": null,
                "ttl_remaining_seconds": null
            }
        ],
 *                 "generating": [
                    {
                        "request_id": "3fcd88d1-81f9-4f62-84b3-c79b2c193625",
                        "elapsed_seconds": 2.8961577499999294,
                        "generated_tokens": 35,
                        "tokens_per_second": 12.084977070051123,
                        "last_activity_age_seconds": 0.06923745799986136,
                        "prompt_tokens": 6626,
                        "max_tokens": 32768
                    }
                ],

                "prefilling": [
                    {
                        "request_id": "746b3299-d200-42b9-999f-1325e9b43607",
                        "processed": 748,
                        "total": 1821,
                        "speed": 0.0,
                        "eta": null,
                        "elapsed": 0.3,
                        "phase": "prefill",
                        "detail": null
                    }
                ],

                                "waiting_requests": 1,
                "waiting": [
                    {
                        "request_id": "746b3299-d200-42b9-999f-1325e9b43607",
                        "queue_position": 1,
                        "elapsed_seconds": 2.1693446669996774,
                        "prompt_tokens": 7965
                    }
                ],
                ```
