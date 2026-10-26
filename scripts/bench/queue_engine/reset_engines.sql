-- Fresh queues for both engines (called before every run).
do $$ declare q text; begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'bench_dispatch';
  truncate net._http_response;
  delete from cron.job_run_details;
  for q in select queue_name from pgmq.list_queues() loop perform pgmq.drop_queue(q); end loop;
  for q in select queue_name from pgque.queue loop
    perform pgque.unsubscribe(q, 'capgo');
    perform pgque.drop_queue(q, true);
  end loop;
  for q in select name from bench.queues loop
    perform pgmq.create(q);
    perform pgque.create_queue(q);
    perform pgque.subscribe(q, 'capgo');
  end loop;
end $$;
