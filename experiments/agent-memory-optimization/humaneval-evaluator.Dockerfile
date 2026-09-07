FROM python:3.11-slim

WORKDIR /opt/human-eval
COPY . /opt/human-eval
RUN pip install --no-cache-dir -r requirements.txt
# Upstream requires every problem in the problem file to be attempted. The
# experiment evaluates frozen dev/test subsets; remove only that completeness
# assertion while retaining the official tests and execution logic unchanged.
RUN sed -i '/assert len(completion_id) == len(problems)/d' human_eval/evaluation.py

ENV PYTHONPATH=/opt/human-eval
ENTRYPOINT ["python", "-m", "human_eval.evaluate_functional_correctness"]
